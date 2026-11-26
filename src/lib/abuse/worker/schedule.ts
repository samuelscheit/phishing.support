import { AbuseRepository } from "../repository";
import type { AbuseProviderRoute } from "../schema";
import { MINUTE_MS, HOUR_MS, DAY_MS } from "../../util/date_time";

/** Queue the delivery of a verified route through its channel: its provider's submission, or its mail. One pending delivery per route. */
export async function queueRouteDelivery(route: Pick<AbuseProviderRoute, "id" | "reportId" | "routeType" | "status">): Promise<void> {
	if (route.status !== "verified" || route.routeType === "manual_unroutable") return;
	await AbuseRepository.enqueueJob(route.routeType === "provider_submission"
		? { jobType: "submit_provider", reportId: route.reportId, routeId: route.id, payload: {}, dedupeKey: `provider-submit:${route.id.toString()}` }
		: { jobType: "send_email", reportId: route.reportId, routeId: route.id, payload: {}, dedupeKey: `email:${route.id.toString()}` });
}

/** How long, and how often, a submitted report's provider correspondence is read. */
export const CORRESPONDENCE_POLL_WINDOW_MS = 30 * DAY_MS;
const CORRESPONDENCE_POLL_INTERVAL_MS = 60 * 60_000;
/**
 * Reads soon after submitting, measured from it, before the hourly ones.
 * Cloudflare emails its receipt and the hosting provider it names within
 * seconds; a read right at submission found nothing and the next came an
 * hour later, holding back the follow-up with that host.
 */
const CORRESPONDENCE_EARLY_POLLS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

/** How long after a read the next one is due, by the time since the report was submitted. */
export function nextCorrespondencePollDelayMs(sinceSubmittedMs: number): number {
	const early = CORRESPONDENCE_EARLY_POLLS_MS.find((offset) => offset > sinceSubmittedMs);
	return early === undefined ? CORRESPONDENCE_POLL_INTERVAL_MS : early - Math.max(0, sinceSubmittedMs);
}

/**
 * When a submission whose answer was lost is looked for at its provider,
 * measured from the submission. A provider can list a report minutes after
 * storing it: Cloudflare report 8bb11a971b4aee08 (hostsync.pro, stored at
 * 18:51:08 behind an HTTP 504) was not in its submitted list at the lookups
 * 1 and 5 minutes after the POST but was at the one after 30. The lookups at
 * 3 and 15 minutes settle such a route, and start reading its
 * correspondence, sooner. After the last lookup the route stays for a person.
 */
export const RECEIPT_LOOKUPS_MS = [MINUTE_MS, 3 * MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, DAY_MS] as const;

/** How long until the next receipt lookup, or undefined once the schedule is over. */
export function nextReceiptLookupDelayMs(sinceSubmittedMs: number): number | undefined {
	const next = RECEIPT_LOOKUPS_MS.find((offset) => offset > sinceSubmittedMs);
	return next === undefined ? undefined : next - Math.max(0, sinceSubmittedMs);
}

/** Queue the next receipt lookup for an ambiguous run; one pending lookup per run. */
export async function queueReceiptLookup(route: { id: bigint; reportId: bigint }, runId: bigint, options: { delayMs: number; successorOf?: bigint }): Promise<void> {
	await AbuseRepository.enqueueJob({
		jobType: "find_provider_receipt",
		reportId: route.reportId,
		routeId: route.id,
		runId,
		dedupeKey: `find-provider-receipt:${runId.toString()}`,
		nextAttemptAt: new Date(Date.now() + options.delayMs),
		...(options.successorOf === undefined ? {} : { successorOf: options.successorOf }),
	});
}

/** Queue the next correspondence read for a route; one pending poll per route. */
export async function queueCorrespondencePoll(route: { id: bigint; reportId: bigint }, options: { delayMs?: number; successorOf?: bigint } = {}): Promise<void> {
	await AbuseRepository.enqueueJob({
		jobType: "poll_provider_correspondence",
		reportId: route.reportId,
		routeId: route.id,
		dedupeKey: `poll-provider-correspondence:${route.id.toString()}`,
		nextAttemptAt: new Date(Date.now() + (options.delayMs ?? 0)),
		...(options.successorOf === undefined ? {} : { successorOf: options.successorOf }),
	});
}
