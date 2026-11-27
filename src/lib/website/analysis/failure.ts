import { isBrowserInfrastructureFailure } from "../archive/errors";
import { errorText } from "../../util/error_text";
import { SubmissionsEntity } from "../../db/entities/submissions";
import type { WebsiteSubmissionData } from "../../db/schema";
import { sleep } from "../../util/sleep";
import { enqueueWebsiteVisit } from "../visit_queue/queue";

/** Capture retries after a browser-service failure: 5 s, 15 s, then 45 s. */
export const BROWSER_BACKOFF_MS = [5_000, 15_000, 45_000] as const;

/**
 * Retry a capture only when the browser service failed (relay full, a dropped
 * CDP connection, a closed target). A site that blocks or times out was
 * already retried across every egress inside the capture and is final. An
 * abort of `signal` ends it at once with the signal's reason: no further
 * attempt, no further wait.
 */
export async function withBrowserBackoff<T>(capture: () => Promise<T>, delaysMs: readonly number[], signal?: AbortSignal): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		try {
			return await capture();
		} catch (error) {
			signal?.throwIfAborted();
			const delayMs = delaysMs[attempt];
			if (delayMs === undefined || !isBrowserInfrastructureFailure(error)) throw error;
			console.warn(`Website capture hit a browser-service failure (${errorText(error)}); retrying in ${delayMs / 1000}s.`);
			await sleep(delayMs, signal);
		}
	}
}

/** Default automatic re-queues of a failure another visit can change: 10 minutes apart, at most 3 times. */
const AUTO_RETRY_DELAY_MS = 10 * 60_000;
const MAX_AUTO_RETRIES = 3;
const DEFAULT_AUTO_RETRY_DELAYS_MS: readonly number[] = Array.from({ length: MAX_AUTO_RETRIES }, () => AUTO_RETRY_DELAY_MS);

/**
 * Automatic re-queues for a browser-service outage: progressive backoff
 * spanning 24 hours (matching the abuse worker's `JOB_WAIT_LIMIT_MS`), so
 * an hours-long Fabric outage recovers automatically without losing cases.
 */
export const BROWSER_OUTAGE_RETRY_DELAYS_MS: readonly number[] = [
	5 * 60_000,
	10 * 60_000,
	15 * 60_000,
	30 * 60_000,
	...Array.from({ length: 23 }, () => 60 * 60_000),
];

/**
 * Fail the case with a readable reason. A failure another visit can change
 * (`retry`: the browser service failed, or the site's flow could not be
 * finished) is re-queued automatically instead of waiting until someone
 * notices, as a visit job due after its backoff; `exhausted` says so once the
 * retries are spent.
 */
export async function failWebsiteAnalysis(submissionId: bigint, failure: {
	info: string;
	data?: Partial<WebsiteSubmissionData>;
	retry?: { attempts: number; reason: string; delaysMs?: readonly number[]; exhausted: (visits: number) => string };
}): Promise<void> {
	const submission = await SubmissionsEntity.get(submissionId);
	const current = submission?.data.kind === "website" ? submission.data.website : undefined;
	const website = current && { ...current, ...failure.data, autoRetry: undefined };
	const { retry } = failure;
	const delaysMs = retry?.delaysMs ?? DEFAULT_AUTO_RETRY_DELAYS_MS;
	const delayMs = retry ? delaysMs[retry.attempts] : undefined;
	if (!website || !retry || delayMs === undefined) {
		await SubmissionsEntity.update(submissionId, {
			status: "failed",
			info: website && retry ? `${failure.info} ${retry.exhausted(retry.attempts + 1)}` : failure.info,
			...(website ? { data: { kind: "website" as const, website } } : {}),
		});
		return;
	}
	const nextAttemptAt = new Date(Date.now() + delayMs);
	await SubmissionsEntity.update(submissionId, {
		status: "failed",
		info: `${failure.info} Retrying automatically at ${nextAttemptAt.toISOString().slice(11, 16)} UTC (attempt ${retry.attempts + 1} of ${delaysMs.length}).`,
		data: { kind: "website", website: { ...website, autoRetry: { attempts: retry.attempts + 1, nextAttemptAt: nextAttemptAt.toISOString(), reason: retry.reason } } },
	});
	await enqueueWebsiteVisit({ submission: submission!, trigger: "automatic", notBefore: nextAttemptAt });
}

/** A failed run: retried automatically when the browser service (not the site) failed. */
export async function recordWebsiteAnalysisFailure(submissionId: bigint, error: unknown, attempts: number): Promise<void> {
	const reason = errorText(error);
	await failWebsiteAnalysis(submissionId, isBrowserInfrastructureFailure(error)
		? { info: `The browser service failed (${reason}).`, retry: { attempts, reason, delaysMs: BROWSER_OUTAGE_RETRY_DELAYS_MS, exhausted: (visits) => `It failed ${visits} times in a row; retry once it has recovered.` } }
		: { info: reason });
}
