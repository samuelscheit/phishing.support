import { z } from "zod";

import { NetcraftSubmissionRejectedError, parseNetcraftSubmissionResponse } from "../netcraft/api";
import { serviceIdentity, serviceUserAgent } from "../../../network/service_identity";
import { normalizeMailbox } from "../../mail/shared";
import { createDraft, type VerifiedOf } from "../kit/draft";
import { preparedState } from "../kit/session";
import { payloadEnvelope, storedReader } from "../kit/stored";
import { ProviderSubmissionRejectedError, type ProviderSubmissionContext, type ProviderSubmissionPreflight, type ProviderSubmissionSuccess } from "../submission_contracts";
import { NETCRAFT_MAIL_PROVIDER } from "./definition";
import { sha256Hex } from "../../../util/hash";
import { fetchAs, type FetchLike } from "../../../http/fetch";

const envelope = payloadEnvelope(NETCRAFT_MAIL_PROVIDER, "netcraft_report_mail_v3");

const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: z.string() }),
	/** The reported message, pinned by hash; the bytes stay in the evidence artifact. */
	message: z.object({ artifactId: z.string(), sha256: z.string(), bytes: z.number() }),
	report: z.object({ reporterEmail: z.string().refine((email) => normalizeMailbox(email) === email) }),
});

type NetcraftMailSubmissionPayload = z.infer<typeof payloadSchema>;

export type NetcraftMailSubmissionDependencies = { fetch?: FetchLike };

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

export const netcraftMailDraft = createDraft({
	definition: NETCRAFT_MAIL_PROVIDER,
	reasonPrefix: "netcraft_mail",
	targetTypes: ["email"],
	targetReason: "netcraft_mail_requires_an_email_target",
	read: storedReader(payloadSchema),
	// The stored draft names its message: a different one that arrived later is not swapped in.
	input: ({ target, evidenceArtifacts }, stored: NetcraftMailSubmissionPayload | undefined) => {
		const artifact = evidenceArtifacts.find((candidate) => stored ? candidate.id.toString() === stored.message.artifactId : candidate.mimeType === "message/rfc822");
		const intact = artifact && sha256Hex(artifact.blob) === artifact.sha256 ? artifact : undefined;
		return {
			target: target.normalizedTarget,
			artifact: intact,
			bytes: intact ? Buffer.byteLength(netcraftMailMessage(intact.blob.toString("utf-8")), "utf-8") : 0,
			reporterEmail: stored?.report.reporterEmail ?? serviceIdentity.mailbox,
		};
	},
	admit: (_data, input) => !input.artifact ? "netcraft_mail_requires_the_reported_message"
		: input.bytes > NETCRAFT_MAIL_PROVIDER.maximumMessageBytes ? "netcraft_mail_message_exceeds_20_mib"
		: undefined,
	build: ({ target, artifact, bytes, reporterEmail }) => artifact && {
		...envelope.stamp,
		target: { normalizedTarget: target },
		message: { artifactId: artifact.id.toString(), sha256: artifact.sha256, bytes },
		report: { reporterEmail },
	},
	targetOf: (payload) => payload.target.normalizedTarget,
});

/** Before the marker: verify the draft and read the message it pins, as Netcraft takes it. */
export async function prepareNetcraftMailExternalSubmission(_context: ProviderSubmissionContext, { payload, data }: VerifiedOf<typeof netcraftMailDraft>): Promise<ProviderSubmissionPreflight> {
	const artifact = data.evidenceArtifacts.find((item) => item.id.toString() === payload.message.artifactId)!;
	return { state: netcraftMailMessage(artifact.blob.toString("utf-8")) };
}

export async function submitNetcraftMailSubmission(
	context: ProviderSubmissionContext,
	preflight: ProviderSubmissionPreflight,
	dependencies: NetcraftMailSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const payload = netcraftMailDraft.stored(context);
	const message = preparedState<string>(preflight, (state) => typeof state === "string", "Netcraft mail submission requires its prepared message.");
	const response = await fetchAs(serviceUserAgent, dependencies.fetch)(NETCRAFT_MAIL_PROVIDER.reportMailUrl, {
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
			submittedTargets: [payload.target.normalizedTarget],
		};
	} catch (error) {
		if (error instanceof NetcraftSubmissionRejectedError) throw new ProviderSubmissionRejectedError(error.message);
		throw error;
	}
}
