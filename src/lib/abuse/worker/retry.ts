import { isBrowserUnavailable } from "../../browser/fabric";
import { DAY_MS, MINUTE_MS } from "../../util/date_time";
import type { JobGiveUp } from "../persistence/provider_runs";
import { ProviderSubmissionRetryLaterError } from "../providers/submission_contracts";
import { WebsiteVisitPendingError } from "../../website/visit_queue/queue";


export const MAX_RETRIES = 8;

/**
 * How long a job keeps waiting for what it needs (a browser, a provider's
 * limit to lift), counted from the job's creation, before a person takes
 * over. Such waits spend none of the job's `MAX_RETRIES`: nothing was done,
 * so nothing failed.
 */
export const JOB_WAIT_LIMIT_MS = 24 * 60 * 60_000;

/** The wait before a job without a browser tries again: a minute at first, a quarter of the time waited so far later, at most 15 minutes. */
export function browserWaitDelayMs(waitedMs: number): number {
	return Math.min(15 * 60_000, Math.max(60_000, Math.round(waitedMs / 4)));
}

/** The longest any error may ask a job to wait before its next attempt. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** A job that waits for what it needs: when it tries again, and how it ends once `JOB_WAIT_LIMIT_MS` has passed. */
export type JobWait = { afterMs: number; giveUp: JobGiveUp; describe: (waitedHours: number) => string };

/** The wait an error asks for, when it says the job did nothing and needs something that is not there yet. */
export function jobWaitOf(error: unknown, waitedMs: number): JobWait | undefined {
	if (isBrowserUnavailable(error)) {
		return {
			afterMs: browserWaitDelayMs(waitedMs),
			// A missing browser is never the route's failure: a person decides once the wait is over.
			giveUp: { routeStatus: "needs_human", reason: "browser_unavailable" },
			describe: (hours) => `No browser for ${hours} h; a person must decide.`,
		};
	}
	if (error instanceof WebsiteVisitPendingError) {
		return {
			afterMs: Math.max(error.retryAfterMs, Math.min(15 * 60_000, Math.round(waitedMs / 4))),
			giveUp: { routeStatus: "needs_human", reason: "visit_pending" },
			describe: (hours) => `The website visit it needs was still not done after ${hours} h.`,
		};
	}
	if (error instanceof ProviderSubmissionRetryLaterError) {
		return {
			afterMs: Math.min(MAX_RETRY_AFTER_MS, Math.max(browserWaitDelayMs(waitedMs), error.retryAfterMs)),
			giveUp: { routeStatus: "needs_human", reason: "provider_limit" },
			describe: (hours) => `The provider kept refusing the report at its limit for ${hours} h; a person must decide.`,
		};
	}
	return undefined;
}

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
