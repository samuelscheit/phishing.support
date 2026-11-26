import { AbuseRepository } from "@/lib/abuse/repository";
import { AnalysisRunsEntity } from "@/lib/db/entities/analysis_runs";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { SubmissionKind } from "@/lib/db/schema";

/** A user-facing validation error for a retry that cannot safely be queued. */
export class SubmissionRetryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SubmissionRetryError";
	}
}

/**
 * Load and validate the common retry boundary for an analysis submission.
 *
 * Retrying is limited to analyses that failed or found nothing reportable
 * (`invalid`) and have not crossed the reporting boundary: an invalid verdict
 * can be wrong (a capture that missed what the page hides), and nothing of it
 * reached a provider. Callers may allow completed stages to be superseded when
 * a later stage, including the report handoff itself, failed; active runs and
 * any report work are never replayed. The status transition is performed by each analyzer after
 * kind-specific source validation, so concurrent requests are serialized by the
 * database rather than by the HTTP process.
 */
export async function getRetryableSubmission(
	submissionId: bigint,
	kind: SubmissionKind,
	options: { allowCompletedPriorRuns?: boolean } = {},
) {
	const submission = await SubmissionsEntity.get(submissionId);
	if (!submission || submission.kind !== kind) {
		throw new SubmissionRetryError(`Only ${kind} submissions can be retried.`);
	}
	if (submission.status !== "failed" && submission.status !== "invalid") {
		throw new SubmissionRetryError("Only failed or unreported submissions can be retried.");
	}

	const [runs, report] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		AbuseRepository.getReportForSubmission(submissionId),
	]);
	// A website has two analysis runs (narrative, then classification) and can
	// fail after both completed, while handing the finding to reporting. Only an
	// existing report makes replay unsafe: it may already have reached providers.
	if (
		runs.some((run) => run.status === "running") ||
		(!options.allowCompletedPriorRuns && runs.some((run) => run.status === "completed")) ||
		report
	) {
		throw new SubmissionRetryError("This submission already completed analysis or reporting and cannot be retried.");
	}

	return { submission, runs };
}
