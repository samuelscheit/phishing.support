import { AbuseRepository } from "@/lib/abuse/repository";
import { AnalysisRunsEntity } from "@/lib/db/entities/analysis_runs";
import { SubmissionRetriesEntity } from "@/lib/db/entities/submission_retries";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { Submission, SubmissionKind, SubmissionRetryTrigger, SubmissionStatus } from "@/lib/db/schema";
import { formatUtcDateTime } from "@/lib/util/date_time";

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
 * can be wrong (a capture that missed what the page hides, case
 * 384401854580134038), and nothing of it reached a provider. Completed
 * analysis runs are superseded by the retry's own, of either kind: a case is
 * judged not reportable after its runs completed, and a case can fail after
 * them while handing its finding to reporting. Only a running run or an
 * existing report makes a replay unsafe: the report may already have reached
 * providers. The claim (`claimRetry`) follows each analyzer's kind-specific
 * source validation, so concurrent requests are serialized by the database
 * rather than by the HTTP process.
 */
export async function getRetryableSubmission(submissionId: bigint, kind: SubmissionKind) {
	const submission = await SubmissionsEntity.get(submissionId);
	if (!submission || submission.kind !== kind) {
		throw new SubmissionRetryError(`Only ${kind} submissions can be retried.`);
	}
	// A collected host may be visited on its own after all.
	if (submission.status !== "failed" && submission.status !== "invalid" && !(kind === "website" && submission.status === "collected")) {
		throw new SubmissionRetryError("Only failed or unreported submissions can be retried.");
	}

	const [runs, report] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		AbuseRepository.getReportForSubmission(submissionId),
	]);
	if (runs.some((run) => run.status === "running") || report) {
		throw new SubmissionRetryError("This submission is being analyzed or was already reported and cannot be retried.");
	}

	return { submission, runs };
}

/**
 * How long a case waits after a retry before anyone may start another by
 * hand. The retry route takes no login, and every website retry visits the
 * site again and every retry runs the models again: without a pause, one
 * case could be re-run without end. Automatic retries keep their own backoff.
 */
export const MANUAL_RETRY_COOLDOWN_MS = 10 * 60_000;

/**
 * The one place a retry takes a case: it moves the case from the status it
 * was validated at to `to` (running, or queued for a website visit that
 * waits its turn) and records the retry, manual or automatic, with what the
 * case stood at. A request that lost the race to another retry, or a manual
 * one within the cooldown, is refused and records nothing.
 */
export async function claimRetry(
	submission: Pick<Submission, "id" | "status">,
	trigger: SubmissionRetryTrigger,
	{ to = "running", now = new Date() }: { to?: Extract<SubmissionStatus, "running" | "queued">; now?: Date } = {},
): Promise<void> {
	if (trigger === "manual") {
		const { lastAt } = await SubmissionRetriesEntity.summaryForSubmission(submission.id);
		const allowedAt = lastAt ? lastAt.getTime() + MANUAL_RETRY_COOLDOWN_MS : 0;
		if (allowedAt > now.getTime()) {
			throw new SubmissionRetryError(`This case was analyzed again moments ago; it can be analyzed again from ${formatUtcDateTime(new Date(allowedAt))}.`);
		}
	}
	const claimed = await SubmissionRetriesEntity.claim({ submissionId: submission.id, from: submission.status, to, trigger });
	if (!claimed) throw new SubmissionRetryError("This submission is already being retried.");
}
