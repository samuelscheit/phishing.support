import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseEvents, abuseProviderRoutes, abuseProviderRuns } from "../schema";
import { insertQueuedJob } from "./jobs";
import { recomputeReportStatusInTransaction } from "./report_status";
import { now, recordEvent } from "./shared";

/** How a run settled by the worker's retry limit names a missing browser (`BrowserUnavailableError`, through any wrapper). */
const BROWSER_UNAVAILABLE_TEXT = "no browser was available";

/**
 * One-off repair, to run once in production after the deploy that made the
 * worker defer jobs without a browser: provider-submission routes that ended
 * `failed` only because no browser was available (2026-11-20/21: Patchright's
 * in-process connection was closed by our own lease release). Each such run
 * never passed its submission marker, so nothing was filed: the run goes back
 * to `starting`, the route to `queued`, and a `submit_provider` job is queued,
 * all in one transaction.
 *
 * A route is taken only when it is `failed`, its latest run is `failed` with
 * the missing-browser text, and no run of the route ever recorded the
 * submission marker. Idempotent: a requeued route is no longer `failed`.
 * Returns the IDs of the requeued routes.
 */
export async function requeueBrowserUnavailableSubmissions(): Promise<bigint[]> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const requeued: bigint[] = [];
			const routes = tx.select().from(abuseProviderRoutes)
				.where(and(eq(abuseProviderRoutes.status, "failed"), eq(abuseProviderRoutes.routeType, "provider_submission")))
				.all();
			for (const route of routes) {
				const run = tx.select().from(abuseProviderRuns)
					.where(eq(abuseProviderRuns.routeId, route.id))
					.orderBy(desc(abuseProviderRuns.createdAt), desc(abuseProviderRuns.id))
					.limit(1)
					.get();
				if (!run || run.executionStatus !== "failed" || !run.failureReason?.includes(BROWSER_UNAVAILABLE_TEXT)) continue;
				const markerReached = tx.select({ id: abuseEvents.id }).from(abuseEvents)
					.where(and(eq(abuseEvents.routeId, route.id), eq(abuseEvents.eventType, "provider_run.provider_submission_started")))
					.get();
				if (markerReached) continue;

				const timestamp = now();
				tx.update(abuseProviderRuns)
					.set({ executionStatus: "starting", failureReason: null, updatedAt: timestamp })
					.where(eq(abuseProviderRuns.id, run.id))
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.requeued",
					data: { from: "failed", to: "starting", reason: "browser_unavailable", previousFailure: run.failureReason },
				});
				tx.update(abuseProviderRoutes)
					.set({ status: "queued", updatedAt: timestamp })
					.where(eq(abuseProviderRoutes.id, route.id))
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "route.status_changed",
					data: { from: "failed", to: "queued", reason: "browser_unavailable_requeued" },
				});
				insertQueuedJob(tx, { jobType: "submit_provider", reportId: route.reportId, routeId: route.id, payload: {}, dedupeKey: `provider-submit:${route.id.toString()}` });
				recomputeReportStatusInTransaction(tx, route.reportId, { reason: "browser_unavailable_requeued", routeId: route.id.toString() });
				requeued.push(route.id);
			}
			return requeued;
		},
		{ behavior: "immediate" },
	);
}
