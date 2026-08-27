import { AnalysisRunsEntity, ProviderReportsEntity, ReportThreadsEntity, SubmissionsEntity } from "@/lib/db/entities";
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
 * Retrying is deliberately limited to failed analyses that have not crossed the
 * reporting boundary. Callers may allow a completed earlier stage to be
 * superseded when a later stage failed; active runs and any report work are
 * never replayed. The status transition is performed by each analyzer after
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
	if (submission.status !== "failed") {
		throw new SubmissionRetryError("Only failed submissions can be retried.");
	}

	const [runs, reportThreads, providerReports] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		ReportThreadsEntity.listForSubmission(submissionId),
		ProviderReportsEntity.listForSubmission(submissionId),
	]);
	// A website has two analysis runs (narrative, then classification), so an
	// earlier completed run is expected when the later classification run fails.
	// The latest run must be failed; any report work still makes replay unsafe.
	const latestRun = runs.reduce<(typeof runs)[number] | undefined>((latest, run) => {
		if (!latest) return run;
		if (run.createdAt > latest.createdAt) return run;
		if (run.createdAt.getTime() === latest.createdAt.getTime() && run.id > latest.id) return run;
		return latest;
	}, undefined);
	if (
		runs.some((run) => run.status === "running") ||
		(!options.allowCompletedPriorRuns && runs.some((run) => run.status === "completed")) ||
		(latestRun && latestRun.status !== "failed") ||
		reportThreads.length > 0 ||
		providerReports.length > 0
	) {
		throw new SubmissionRetryError("This submission already completed analysis or reporting and cannot be retried.");
	}

	return { submission, runs };
}
