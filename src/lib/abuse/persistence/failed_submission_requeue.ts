import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseArtifacts, abuseEvents, abuseProviderRoutes, abuseProviderRuns, abuseReports } from "../schema";
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

/** Route refusals a missing brand caused, by the `reason` `settleKnownFailure` recorded. */
const BRAND_REASONS = [
	"tucows_requires_a_brand_domain",
	"namesilo_requires_a_verified_brand_website",
	"eranet_requires_a_reference_website",
	"gname_requires_a_reference_website",
];

/**
 * The 2026-11-26 repair: linked reports (exfiltration backends, payload hosts)
 * were stored without `legalBrandUrl`, so providers that need a brand refused
 * them without a run (`insufficient_evidence`). Run once after the deploy where
 * linked reports inherit their page's brand, then delete. In one transaction
 * each such route whose report has no brand and whose source report (named by
 * its `original_request` artifact) has one inherits it, goes back to the status
 * it was refused from, and gets a `submit_provider` job. Routes with any run
 * are skipped: they were prepared or sent. Idempotent. Returns the requeued route IDs.
 *
 *     docker exec <phishingsupport-frontend> bun -e 'const m = await import("/app/src/lib/abuse/persistence/failed_submission_requeue.ts"); console.log(await m.requeueBrandRefusedLinkedRoutes())'
 */
export async function requeueBrandRefusedLinkedRoutes(): Promise<bigint[]> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const requeued: bigint[] = [];
			const routes = tx.select().from(abuseProviderRoutes)
				.where(and(eq(abuseProviderRoutes.status, "insufficient_evidence"), eq(abuseProviderRoutes.routeType, "provider_submission")))
				.all();
			for (const route of routes) {
				const refusal = tx.select().from(abuseEvents)
					.where(and(eq(abuseEvents.routeId, route.id), eq(abuseEvents.eventType, "route.status_changed")))
					.orderBy(desc(abuseEvents.createdAt), desc(abuseEvents.id))
					.all()
					.find((event) => event.data.to === "insufficient_evidence");
				if (typeof refusal?.data.reason !== "string" || !BRAND_REASONS.includes(refusal.data.reason)) continue;
				if (tx.select({ id: abuseProviderRuns.id }).from(abuseProviderRuns).where(eq(abuseProviderRuns.routeId, route.id)).get()) continue;
				const report = tx.select().from(abuseReports).where(eq(abuseReports.id, route.reportId)).get();
				if (!report || report.legalBrandUrl !== null) continue;
				const original = tx.select().from(abuseArtifacts)
					.where(and(eq(abuseArtifacts.reportId, route.reportId), eq(abuseArtifacts.kind, "original_request")))
					.orderBy(desc(abuseArtifacts.createdAt), desc(abuseArtifacts.id))
					.limit(1)
					.get();
				let sourceId: bigint | undefined;
				try {
					const sourceReportId = original ? (JSON.parse(Buffer.from(original.blob).toString("utf8")) as { sourceReportId?: unknown }).sourceReportId : undefined;
					if (typeof sourceReportId === "string" && /^\d+$/.test(sourceReportId)) sourceId = BigInt(sourceReportId);
				} catch {
					continue;
				}
				if (sourceId === undefined) continue;
				const legalBrandUrl = tx.select({ url: abuseReports.legalBrandUrl }).from(abuseReports).where(eq(abuseReports.id, sourceId)).get()?.url;
				if (!legalBrandUrl) continue;

				const timestamp = now();
				const to = refusal.data.from === "verified" ? "verified" : "queued";
				tx.update(abuseReports).set({ legalBrandUrl, updatedAt: timestamp }).where(eq(abuseReports.id, report.id)).run();
				recordEvent(tx, {
					reportId: report.id,
					eventType: "report.legal_brand_inherited",
					data: { sourceReportId: sourceId.toString(), legalBrandUrl },
				});
				tx.update(abuseProviderRoutes).set({ status: to, updatedAt: timestamp }).where(eq(abuseProviderRoutes.id, route.id)).run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					eventType: "route.status_changed",
					data: { from: "insufficient_evidence", to, reason: "linked_brand_inherited" },
				});
				insertQueuedJob(tx, { jobType: "submit_provider", reportId: route.reportId, routeId: route.id, payload: {}, dedupeKey: `provider-submit:${route.id.toString()}` });
				recomputeReportStatusInTransaction(tx, route.reportId, { reason: "linked_brand_inherited", routeId: route.id.toString() });
				requeued.push(route.id);
			}
			return requeued;
		},
		{ behavior: "immediate" },
	);
}
