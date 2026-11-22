export const MAX_RETRIES = 8;

/**
 * How long a job that finds no browser keeps waiting for one, counted from
 * the job's creation, before a person takes over. Such waits spend none of
 * the job's `MAX_RETRIES`: nothing ran, so nothing failed.
 */
export const BROWSER_WAIT_LIMIT_MS = 24 * 60 * 60_000;

/** The wait before a job without a browser tries again: a minute at first, a quarter of the time waited so far later, at most 15 minutes. */
export function browserWaitDelayMs(waitedMs: number): number {
	return Math.min(15 * 60_000, Math.max(60_000, Math.round(waitedMs / 4)));
}

/** The longest any error may ask a job to wait before its next attempt. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * How long a failed job waits before its next attempt: exponential backoff,
 * or longer when the error says when its dependency can be tried again
 * (`retryAfterMs`, e.g. a provider login that is backing off). Retrying
 * sooner would only replay that failure and spend the job's retries.
 */
export function retryDelayMs(error: unknown, retryCount: number): number {
	const backoff = Math.min(15 * 60_000, 1_000 * 2 ** retryCount);
	const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
	if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) return backoff;
	return Math.max(backoff, Math.min(Math.ceil(retryAfterMs), MAX_RETRY_AFTER_MS));
}
