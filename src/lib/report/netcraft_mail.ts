import { createHash } from "node:crypto";

import { normalizeMailbox } from "../abuse/mail/shared";
import { ProviderReportsEntity } from "../db/entities";
import type { ProviderReportStatus } from "../db/schema";
import {
	NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES,
	NETCRAFT_REPORT_MAIL_URL,
	NetcraftSubmissionRejectedError,
	type NetcraftFetch,
	parseNetcraftSubmissionResponse,
} from "../netcraft/api";
import { netcraftReporterEmail } from "../netcraft/identity";

export const NETCRAFT_MAIL_REPORT_CHANNEL = "netcraft_mail_v3";
export const NETCRAFT_MAIL_REPORT_TARGET = "Netcraft Reporting API v3";

export type NetcraftMailPayload = {
	email: string;
	message: string;
	messageBytes: number;
	messageSha256: string;
};

export type NetcraftMailReportDependencies = {
	fetch?: NetcraftFetch;
};

export type NetcraftMailReportResult =
	| { outcome: "submitted"; providerReportId: bigint; confirmationId: string; finalUrl: string }
	| { outcome: "rejected"; providerReportId: bigint; error: string }
	| { outcome: "preflight_failed"; providerReportId: bigint; error: string }
	| { outcome: "unknown_external_state"; providerReportId: bigint; error: string }
	| { outcome: "already_processed"; providerReportId: bigint; status: ProviderReportStatus };

/** A local validation failure that did not cross the Netcraft API boundary. */
export class NetcraftMailPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NetcraftMailPayloadError";
	}
}

export function netcraftMailOperationKey(submissionId: bigint): string {
	return `netcraft:mail:${submissionId.toString()}`;
}

/**
 * Preserve the supplied RFC 822/MIME source string without rewriting it,
 * while enforcing Netcraft's documented 20 MiB message cap before it can
 * cross the network boundary.
 */
export function buildNetcraftMailPayload(params: { reporterEmail: string; rawMime: string }): NetcraftMailPayload {
	const email = normalizeMailbox(params.reporterEmail);
	if (!email) throw new NetcraftMailPayloadError("Netcraft reporter email must be a valid mailbox.");
	if (typeof params.rawMime !== "string" || params.rawMime.length === 0) {
		throw new NetcraftMailPayloadError("Netcraft requires a non-empty raw RFC 822/MIME email message.");
	}

	const messageBytes = Buffer.byteLength(params.rawMime, "utf-8");
	if (messageBytes > NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES) {
		throw new NetcraftMailPayloadError(
			`Netcraft accepts raw email messages up to ${NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES} bytes; this message is ${messageBytes} bytes.`,
		);
	}

	return {
		email,
		message: params.rawMime,
		messageBytes,
		messageSha256: createHash("sha256").update(params.rawMime, "utf-8").digest("hex"),
	};
}

function reportBody(messageBytes: number): string {
	return `Original RFC 822/MIME phishing email (${messageBytes.toString()} bytes) submitted through Netcraft's mail-report API.`;
}

function reportData(params: { payload?: NetcraftMailPayload; rawMime: string }) {
	return {
		adapter: "netcraft_report_mail_v3",
		endpoint: NETCRAFT_REPORT_MAIL_URL,
		...(params.payload
			? {
					reporterEmail: params.payload.email,
					rawMimeBytes: params.payload.messageBytes,
					rawMimeSha256: params.payload.messageSha256,
				}
			: { rawMimeBytes: Buffer.byteLength(params.rawMime, "utf-8") }),
	};
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 2_000) || "Unknown Netcraft submission error.";
}

async function settleUnknownExternalState(params: { providerReportId: bigint; error: string }): Promise<NetcraftMailReportResult> {
	try {
		await ProviderReportsEntity.settleExternalSubmission({
			reportId: params.providerReportId,
			status: "unknown_external_state",
			error: params.error,
		});
	} catch (settlementError) {
		console.error("Unable to persist Netcraft mail submission's ambiguous state:", settlementError);
	}
	return { outcome: "unknown_external_state", providerReportId: params.providerReportId, error: params.error };
}

/**
 * Submit one confirmed phishing email to Netcraft. The database marker is
 * committed immediately before fetch, so a restart after this point preserves
 * the ambiguous state rather than replaying a potentially accepted report.
 */
export async function reportNetcraftMail(params: {
	submissionId: bigint;
	rawMime: string;
	analysisRunId?: bigint;
	originalEmlArtifactId?: bigint;
}, dependencies: NetcraftMailReportDependencies = {}): Promise<NetcraftMailReportResult> {
	const operationKey = netcraftMailOperationKey(params.submissionId);
	const attachmentsArtifactIds = params.originalEmlArtifactId === undefined ? undefined : [params.originalEmlArtifactId];

	let payload: NetcraftMailPayload;
	try {
		payload = buildNetcraftMailPayload({ reporterEmail: netcraftReporterEmail(), rawMime: params.rawMime });
	} catch (error) {
		const failure = errorText(error);
		const report = await ProviderReportsEntity.recordExternalSubmissionFailure({
			submissionId: params.submissionId,
			analysisRunId: params.analysisRunId,
			operationKey,
			channel: NETCRAFT_MAIL_REPORT_CHANNEL,
			to: NETCRAFT_MAIL_REPORT_TARGET,
			subject: "Phishing email submission",
			body: reportBody(Buffer.byteLength(params.rawMime, "utf-8")),
			attachmentsArtifactIds,
			data: reportData({ rawMime: params.rawMime }),
			error: failure,
		});
		return { outcome: "preflight_failed", providerReportId: report.id, error: failure };
	}

	const boundary = await ProviderReportsEntity.beginExternalSubmission({
		submissionId: params.submissionId,
		analysisRunId: params.analysisRunId,
		operationKey,
		channel: NETCRAFT_MAIL_REPORT_CHANNEL,
		to: NETCRAFT_MAIL_REPORT_TARGET,
		subject: "Phishing email submission",
		body: reportBody(payload.messageBytes),
		attachmentsArtifactIds,
		data: reportData({ payload, rawMime: params.rawMime }),
	});
	if (!boundary.started) {
		if (boundary.report.status === "submission_started" || boundary.report.status === "unknown_external_state") {
			return {
				outcome: "unknown_external_state",
				providerReportId: boundary.report.id,
				error: "Netcraft mail submission already crossed its durable pre-call boundary and will not be replayed automatically.",
			};
		}
		return { outcome: "already_processed", providerReportId: boundary.report.id, status: boundary.report.status };
	}

	const request = dependencies.fetch ?? globalThis.fetch;
	let response: Response;
	try {
		response = await request(NETCRAFT_REPORT_MAIL_URL, {
			method: "POST",
			redirect: "error",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({ email: payload.email, message: payload.message }),
		});
	} catch (error) {
		return settleUnknownExternalState({ providerReportId: boundary.report.id, error: errorText(error) });
	}

	let receipt: Awaited<ReturnType<typeof parseNetcraftSubmissionResponse>>;
	try {
		receipt = await parseNetcraftSubmissionResponse(response);
	} catch (error) {
		const failure = errorText(error);
		if (error instanceof NetcraftSubmissionRejectedError) {
			try {
				const settled = await ProviderReportsEntity.settleExternalSubmission({
					reportId: boundary.report.id,
					status: "failed",
					error: failure,
				});
				if (settled) return { outcome: "rejected", providerReportId: boundary.report.id, error: failure };
			} catch (settlementError) {
				console.error("Unable to persist rejected Netcraft mail submission:", settlementError);
			}
			return settleUnknownExternalState({
				providerReportId: boundary.report.id,
				error: "Netcraft rejected the email report, but that outcome could not be durably settled.",
			});
		}
		return settleUnknownExternalState({ providerReportId: boundary.report.id, error: failure });
	}

	try {
		const settled = await ProviderReportsEntity.settleExternalSubmission({
			reportId: boundary.report.id,
			status: "sent",
			providerMessageId: receipt.uuid,
			providerSubmissionUrl: receipt.submissionUrl,
		});
		if (settled) {
			return {
				outcome: "submitted",
				providerReportId: boundary.report.id,
				confirmationId: receipt.uuid,
				finalUrl: receipt.submissionUrl,
			};
		}
	} catch (settlementError) {
		console.error("Unable to persist accepted Netcraft mail submission:", settlementError);
	}
	return settleUnknownExternalState({
		providerReportId: boundary.report.id,
		error: "Netcraft accepted the email report, but the confirmation could not be durably settled.",
	});
}
