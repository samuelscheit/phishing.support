export const MAX_RETRIES = 8;

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
