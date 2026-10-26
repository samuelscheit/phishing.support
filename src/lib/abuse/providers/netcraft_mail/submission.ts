import { NetcraftSubmissionRejectedError, parseNetcraftSubmissionResponse, type NetcraftFetch } from "../../../netcraft/api";
import { netcraftReporterEmail } from "../../../netcraft/identity";
import { normalizeMailbox } from "../../mail/shared";
import { sha256Hex } from "../../security";
import { recordValue, routeContext } from "../../worker/shared";
import { providerDefinitionMatchesPin } from "../definition";
import {
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { NETCRAFT_MAIL_PROVIDER } from "./definition";

export type NetcraftMailSubmissionPayload = {
	adapter: "netcraft_report_mail_v3";
	definition: { version: string; contentHash: string };
	/** The reported message, pinned by hash; the bytes stay in the evidence artifact. */
	message: { artifactId: string; sha256: string; bytes: number };
	report: { reporterEmail: string };
};

export type NetcraftMailSubmissionDependencies = { fetch?: NetcraftFetch };

const HEADER_END = /\r?\n\r?\n/;

/**
 * Netcraft rejects a message without a parseable sender ("No valid from
 * address found in mail"). Bounce notifications and some forwarded copies
 * carry no From header at all; the evidence is the body, so the sender is
 * declared explicitly as unknown rather than dropping the report.
 */
export function netcraftMailMessage(raw: string): string {
	const headerEnd = raw.search(HEADER_END);
	const headers = (headerEnd >= 0 ? raw.slice(0, headerEnd) : raw).replace(/\r?\n[ \t]+/g, " ");
	const from = headers.split(/\r?\n/).find((line) => /^from\s*:/i.test(line));
	if (from && /@/.test(from)) return raw;
	const newline = raw.includes("\r\n") ? "\r\n" : "\n";
	const withoutFrom = from ? raw.replace(/^from\s*:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n/im, "") : raw;
	return `From: Unknown sender <unknown-sender@invalid>${newline}${withoutFrom}`;
}

function messageArtifact(evidence: Awaited<ReturnType<typeof routeContext>>["evidenceArtifacts"]) {
	return evidence.find((artifact) => artifact.mimeType === "message/rfc822");
}

export function storedNetcraftMailPayload(value: unknown): NetcraftMailSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const message = payload && recordValue(payload.message);
	const report = payload && recordValue(payload.report);
	if (payload?.adapter !== "netcraft_report_mail_v3"
		|| definition?.version !== NETCRAFT_MAIL_PROVIDER.version || definition.contentHash !== NETCRAFT_MAIL_PROVIDER.contentHash
		|| typeof message?.artifactId !== "string" || typeof message.sha256 !== "string" || typeof message.bytes !== "number"
		|| typeof report?.reporterEmail !== "string" || normalizeMailbox(report.reporterEmail) !== report.reporterEmail) {
		return undefined;
	}
	return {
		adapter: "netcraft_report_mail_v3",
		definition: { version: definition.version, contentHash: definition.contentHash },
		message: { artifactId: message.artifactId, sha256: message.sha256, bytes: message.bytes },
		report: { reporterEmail: report.reporterEmail },
	};
}

export async function prepareNetcraftMailSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const { route, target, evidenceArtifacts } = await routeContext(context.routeId);
	if (route.providerRegistryKey !== NETCRAFT_MAIL_PROVIDER.key || target.targetType !== "email") {
		return { outcome: "insufficient_evidence", reason: "netcraft_mail_requires_an_email_target" };
	}
	if (!providerDefinitionMatchesPin(NETCRAFT_MAIL_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "netcraft_mail_provider_definition_pin_mismatch" };
	}
	const artifact = messageArtifact(evidenceArtifacts);
	if (!artifact || sha256Hex(artifact.blob) !== artifact.sha256) {
		return { outcome: "insufficient_evidence", reason: "netcraft_mail_requires_the_reported_message" };
	}
	const message = Buffer.from(netcraftMailMessage(artifact.blob.toString("utf-8")), "utf-8");
	if (message.byteLength > NETCRAFT_MAIL_PROVIDER.maximumMessageBytes) {
		return { outcome: "insufficient_evidence", reason: "netcraft_mail_message_exceeds_20_mib" };
	}
	return {
		outcome: "ready",
		payload: {
			adapter: "netcraft_report_mail_v3",
			definition: { version: NETCRAFT_MAIL_PROVIDER.version, contentHash: NETCRAFT_MAIL_PROVIDER.contentHash },
			message: { artifactId: artifact.id.toString(), sha256: artifact.sha256, bytes: message.byteLength },
			report: { reporterEmail: netcraftReporterEmail() },
		} satisfies NetcraftMailSubmissionPayload,
	};
}

export async function submitNetcraftMailSubmission(
	context: ProviderSubmissionContext,
	dependencies: NetcraftMailSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const payload = storedNetcraftMailPayload(context.payload);
	if (!payload) throw new Error("The persisted Netcraft mail payload is malformed.");
	const { route, target, evidenceArtifacts } = await routeContext(context.routeId);
	const artifact = evidenceArtifacts.find((item) => item.id.toString() === payload.message.artifactId);
	if (route.providerRegistryKey !== NETCRAFT_MAIL_PROVIDER.key || target.targetType !== "email"
		|| !providerDefinitionMatchesPin(NETCRAFT_MAIL_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)
		|| !artifact || artifact.sha256 !== payload.message.sha256 || sha256Hex(artifact.blob) !== payload.message.sha256) {
		throw new Error("The persisted Netcraft mail payload no longer matches its report evidence.");
	}
	const message = netcraftMailMessage(artifact.blob.toString("utf-8"));
	const response = await (dependencies.fetch ?? globalThis.fetch)(NETCRAFT_MAIL_PROVIDER.reportMailUrl, {
		method: "POST",
		redirect: "error",
		...(context.signal ? { signal: context.signal } : {}),
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify({ email: payload.report.reporterEmail, message }),
	});
	try {
		const accepted = await parseNetcraftSubmissionResponse(response);
		return {
			confirmationId: accepted.uuid,
			confirmationText: accepted.message ?? "Netcraft accepted the email report.",
			finalUrl: accepted.submissionUrl,
			submittedTargets: [target.normalizedTarget],
		};
	} catch (error) {
		if (error instanceof NetcraftSubmissionRejectedError) throw new ProviderSubmissionRejectedError(error.message);
		throw error;
	}
}
