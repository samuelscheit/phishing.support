import { DAY_MS, MINUTE_MS } from "../../util/date_time";


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

/** The most sends a route makes to a mailbox that keeps failing temporarily. */
export const MAX_DELIVERY_SENDS = 6;
/** How long after its first send a route stops resending to a mailbox that keeps failing temporarily. */
export const MAX_DELIVERY_RETRY_MS = 3 * DAY_MS;
const FIRST_DELIVERY_RETRY_MS = 15 * MINUTE_MS;

/**
 * When to resend after a temporary delivery failure (a full mailbox, a
 * greylisting or overloaded server): 15 minutes after the first send's
 * failure, doubling with each send, at most a day. Undefined once the route
 * has made `MAX_DELIVERY_SENDS` sends or the resend would come later than
 * `MAX_DELIVERY_RETRY_MS` after its first: a failure that lasts that long is
 * the mailbox's, and the report moves on as after a permanent one.
 */
export function deliveryRetryDelayMs(sends: readonly Date[], now: Date): number | undefined {
	const count = Math.max(1, sends.length);
	if (count >= MAX_DELIVERY_SENDS) return undefined;
	const delay = Math.min(DAY_MS, FIRST_DELIVERY_RETRY_MS * 2 ** (count - 1));
	const first = Math.min(now.getTime(), ...sends.map((send) => send.getTime()));
	return now.getTime() + delay - first > MAX_DELIVERY_RETRY_MS ? undefined : delay;
}
