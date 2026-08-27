import { createHash } from "node:crypto";

import { ArtifactsEntity, SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { analyzeMail } from "@/lib/mail_ai";
import type { ReporterMetadata } from "@/lib/request_metadata";

import { getRetryableSubmission, SubmissionRetryError } from "./retry";

export { SubmissionRetryError } from "./retry";

export type EmailSubmissionOptions = ReporterMetadata & {
	source?: string;
};

/** One exact source message is idempotent; unrelated mail from the same sender is not. */
export function emailSubmissionDedupeKey(emlContent: string): string {
	return `email:${createHash("sha256").update(emlContent, "utf-8").digest("hex")}`;
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
 * Re-run a failed analysis that has not crossed the reporting boundary. The
 * original MIME artifact and submission identity are retained; retrying never
 * creates a second submission or duplicates an already-created abuse report.
 */
export async function retryFailedEmailAnalysis(submissionId: bigint): Promise<void> {
	await getRetryableSubmission(submissionId, "email");
	const artifactList = await ArtifactsEntity.listForSubmission(submissionId);

	const original = artifactList.find(
		(artifact) => artifact.kind === "eml" || artifact.mimeType?.toLowerCase() === "message/rfc822" || artifact.name?.toLowerCase() === "mail.eml"
	);
	if (!original) throw new SubmissionRetryError("The original email artifact is unavailable.");
	const artifact = await ArtifactsEntity.get(original.id);
	if (!artifact?.blob) throw new SubmissionRetryError("The original email artifact is unavailable.");

	const claimed = await SubmissionsEntity.transitionStatus(submissionId, "failed", "queued");
	if (!claimed) throw new SubmissionRetryError("This submission is already being retried.");

	void analyzeMail(artifact.blob.toString("utf-8"), submissionId, {
		existingOriginalEmlArtifactId: artifact.id,
		reuseEvidenceArtifacts: true,
	}).catch(async (error) => {
		console.error("Retried email analysis failed:", error);
	});
}
