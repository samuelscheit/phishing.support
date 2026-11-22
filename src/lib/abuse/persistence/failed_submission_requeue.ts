import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseEvents, abuseProviderRoutes, abuseProviderRuns } from "../schema";
import { insertQueuedJob } from "./jobs";
import { recomputeReportStatusInTransaction } from "./report_status";
import { now, recordEvent } from "./shared";

/** Which failed submissions an operator repair sends back: one provider, one failure its fix removed. */
export type FailedSubmissionSelection = {
	providerRegistryKey: string;
	/** Text the latest run's failure reason contains. */
	failure: string;
	/** Names the repair in the events it records. */
	reason: string;
};

/**
 * Operator repair, run once in production after the deploy that fixed the
 * cause: provider-submission routes the worker gave up on (`failed`) for a
 * failure that happened before the submission marker, so nothing was filed.
 * In one transaction the latest run goes back to `starting`, the route to
 * `queued`, and a `submit_provider` job is queued; the submission then
 * resumes from that run.
 *
 * A route is taken only when it belongs to the provider, is `failed`, its
 * latest run is `failed` with a reason containing `failure`, and no run of
 * the route ever recorded the submission marker. Idempotent: a requeued route
 * is no longer `failed`. Returns the IDs of the requeued routes.
 */
export async function requeueFailedPreMarkerSubmissions(selection: FailedSubmissionSelection): Promise<bigint[]> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const requeued: bigint[] = [];
			const routes = tx.select().from(abuseProviderRoutes)
				.where(and(
					eq(abuseProviderRoutes.status, "failed"),
					eq(abuseProviderRoutes.routeType, "provider_submission"),
					eq(abuseProviderRoutes.providerRegistryKey, selection.providerRegistryKey),
				))
				.all();
			for (const route of routes) {
				const run = tx.select().from(abuseProviderRuns)
					.where(eq(abuseProviderRuns.routeId, route.id))
					.orderBy(desc(abuseProviderRuns.createdAt), desc(abuseProviderRuns.id))
					.limit(1)
					.get();
				if (!run || run.executionStatus !== "failed" || !run.failureReason?.includes(selection.failure)) continue;
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
					data: { from: "failed", to: "starting", reason: selection.reason, previousFailure: run.failureReason },
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
					data: { from: "failed", to: "queued", reason: `${selection.reason}_requeued` },
				});
				insertQueuedJob(tx, { jobType: "submit_provider", reportId: route.reportId, routeId: route.id, payload: {}, dedupeKey: `provider-submit:${route.id.toString()}` });
				recomputeReportStatusInTransaction(tx, route.reportId, { reason: `${selection.reason}_requeued`, routeId: route.id.toString() });
				requeued.push(route.id);
			}
			return requeued;
		},
		{ behavior: "immediate" },
	);
}

/**
 * The 2026-11-22 repair: GoDaddy's portal preflight read `grecaptcha` from
 * Patchright's isolated world, where the page's own script never is, and gave
 * up with "grecaptcha did not load" before its marker. Run once after the
 * deploy that reads it from the page's world, then delete:
 *
 *     docker exec <phishingsupport-frontend> bun -e 'const m = await import("/app/src/lib/abuse/persistence/failed_submission_requeue.ts"); console.log(await m.requeueGoDaddyRecaptchaPreflights())'
 */
export function requeueGoDaddyRecaptchaPreflights(): Promise<bigint[]> {
	return requeueFailedPreMarkerSubmissions({ providerRegistryKey: "godaddy", failure: "grecaptcha did not load", reason: "page_world_recaptcha" });
}
