
import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { SubmissionRetriesEntity } from "@/lib/db/entities/submission_retries";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { generateId } from "@/lib/db/ids";
import { analyzeMail } from "@/lib/mail/ai";
import type { ReporterMetadata } from "@/lib/http/reporter_headers";

import { claimRetry, getRetryableSubmission, SubmissionRetryError } from "./retry";
import { sha256Hex } from "../util/hash";

export { SubmissionRetryError } from "./retry";

export type EmailSubmissionOptions = ReporterMetadata & {
	source?: string;
};

/** One exact source message is idempotent; unrelated mail from the same sender is not. */
export function emailSubmissionDedupeKey(emlContent: string): string {
	return `email:${sha256Hex(emlContent)}`;
}

export async function createEmailSubmissionFromEml(emlContent: string, options: EmailSubmissionOptions = {}): Promise<bigint> {
	const streamId = generateId();

	const existingId = await SubmissionsEntity.create({
		kind: "email",
		data: { kind: "email" },
		dedupeKey: emailSubmissionDedupeKey(emlContent),
		id: streamId,
		source: options.source,
		reporterIp: options.reporterIp,
		reporterCountry: options.reporterCountry,
		reporterHeaders: options.reporterHeaders,
	});

	if (existingId !== streamId) return existingId;

	analyzeMail(emlContent, streamId).catch(console.error);

	return streamId;
}

/**
 * Re-run a failed or unreported email analysis that has not crossed the
 * reporting boundary. The original MIME artifact and submission identity are
 * retained; retrying never creates a second submission or duplicates an
 * already-created abuse report. A reporter already told their mail is not
 * phishing hears again only when the retry finds that it is.
 */
export async function retryEmailAnalysis(
	submissionId: bigint,
	analyze: typeof analyzeMail = analyzeMail,
): Promise<void> {
	const { submission } = await getRetryableSubmission(submissionId, "email");
	const artifactList = await ArtifactsEntity.listForSubmission(submissionId);

	const original = artifactList.find(
		(artifact) => artifact.kind === "eml" || artifact.mimeType?.toLowerCase() === "message/rfc822" || artifact.name?.toLowerCase() === "mail.eml"
	);
	if (!original) throw new SubmissionRetryError("The original email artifact is unavailable.");
	const artifact = await ArtifactsEntity.get(original.id);
	if (!artifact?.blob) throw new SubmissionRetryError("The original email artifact is unavailable.");

	// The reporter heard "not phishing" whenever the case was judged so: now, or before a retry that later failed.
	const reporterToldNotPhishing = submission.status === "invalid"
		|| (await SubmissionRetriesEntity.listForSubmission(submissionId)).some((retry) => retry.fromStatus === "invalid");
	await claimRetry(submission, "manual");

	void analyze(artifact.blob.toString("utf-8"), submissionId, { reuseEvidenceArtifacts: true, reporterToldNotPhishing }).catch(async (error) => {
		console.error("Retried email analysis failed:", error);
	});
}
