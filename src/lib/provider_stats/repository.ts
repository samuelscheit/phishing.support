import { asc, desc, eq, inArray, ne } from "drizzle-orm";

import { abuseEvents, abuseMailMessages, abuseProviderRoutes, abuseReports, abuseTargets } from "../abuse/schema";
import { getDb } from "../db";
import { isDown, takedownOf } from "../liveness/layer";
import { listSiteChecks } from "../liveness/repository";
import type { SiteCheck } from "../liveness/schema";
import { asRecord } from "../values";
import type { ProviderRouteRecord } from "./aggregate";
import { organisationOf } from "./organisation";
import { roleOf } from "./role";
import { routeOutcomeOf, type RouteMessageFact } from "./route_outcome";

/** Stats are recomputed at most this often; a new reply shows up on the public pages within minutes. */
const CACHE_MS = 5 * 60_000;

/**
 * The takedown record of a route's site, measured from when the route
 * delivered its report: a site already down then, or not checked since, says
 * nothing about this provider. A route never delivered is measured from the
 * report, for the site state the report list shows.
 */
function routeTakedown(checks: readonly SiteCheck[] | undefined, since: Date) {
	if (!checks?.length) return undefined;
	const at = since.getTime();
	const before = checks.filter((check) => check.checkedAt.getTime() < at).at(-1);
	if (before && isDown(before.state)) return undefined;
	if (!checks.some((check) => check.checkedAt.getTime() >= at)) return undefined;
	return takedownOf(checks, since);
}

/**
 * Every provider route with its outcome and the takedown record of its site.
 * Five reads, none of them of message bodies: the whole history fits in
 * memory, and one pass over it serves every page.
 */
export async function loadProviderRouteRecords(): Promise<ProviderRouteRecord[]> {
	const db = await getDb();
	const routes = db
		.select({ route: abuseProviderRoutes, target: { normalizedTarget: abuseTargets.normalizedTarget, targetType: abuseTargets.targetType }, report: { createdAt: abuseReports.createdAt, submissionId: abuseReports.submissionId } })
		.from(abuseProviderRoutes)
		.innerJoin(abuseTargets, eq(abuseTargets.id, abuseProviderRoutes.targetId))
		.innerJoin(abuseReports, eq(abuseReports.id, abuseProviderRoutes.reportId))
		.where(ne(abuseProviderRoutes.routeType, "manual_unroutable"))
		.all();
	const messages = Map.groupBy(
		db.select({
			routeId: abuseMailMessages.routeId,
			direction: abuseMailMessages.direction,
			kind: abuseMailMessages.kind,
			status: abuseMailMessages.status,
			classification: abuseMailMessages.classification,
			correlationKey: abuseMailMessages.correlationKey,
			occurredAt: abuseMailMessages.occurredAt,
		}).from(abuseMailMessages).all(),
		(message) => message.routeId,
	);
	const events = Map.groupBy(
		db.select({ routeId: abuseEvents.routeId, eventType: abuseEvents.eventType, data: abuseEvents.data, createdAt: abuseEvents.createdAt })
			.from(abuseEvents)
			.where(inArray(abuseEvents.eventType, ["route.status_changed", "provider_decision.not_answered"]))
			.all(),
		(event) => event.routeId,
	);
	const checks = Map.groupBy(await listSiteChecks(), (check: SiteCheck) => check.targetId);

	return routes.map(({ route, target, report }) => {
		const routeEvents = events.get(route.id) ?? [];
		const organisation = organisationOf(route);
		const outcome = routeOutcomeOf({
			routeType: route.routeType,
			status: route.status,
			createdAt: route.createdAt,
			statusChanges: routeEvents
				.filter((event) => event.eventType === "route.status_changed")
				.flatMap((event) => {
					const to = asRecord(event.data)?.to;
					return typeof to === "string" ? [{ to, at: event.createdAt }] : [];
				}),
			messages: (messages.get(route.id) ?? []) as RouteMessageFact[],
			unansweredDecisions: routeEvents.filter((event) => event.eventType === "provider_decision.not_answered").length,
		});
		const takedown = routeTakedown(checks.get(route.targetId), outcome.sentAt ?? report.createdAt);
		return {
			routeId: route.id,
			reportId: route.reportId,
			submissionId: report.submissionId,
			target: target.normalizedTarget,
			targetType: target.targetType,
			organisation,
			role: roleOf(route, target.targetType, organisation),
			channel: route.routeType,
			reportedAt: report.createdAt,
			outcome,
			...(takedown ? { takedown } : {}),
		};
	});
}

/** A report as the public list shows it, whether or not any provider could be reached. */
export type ReportSummary = {
	reportId: bigint;
	submissionId: bigint | null;
	status: string;
	allegationCategory: string;
	createdAt: Date;
	targets: string[];
};

export async function loadReportSummaries(): Promise<ReportSummary[]> {
	const db = await getDb();
	const targets = Map.groupBy(
		db.select({ reportId: abuseTargets.reportId, normalizedTarget: abuseTargets.normalizedTarget }).from(abuseTargets).orderBy(asc(abuseTargets.createdAt)).all(),
		(target) => target.reportId,
	);
	return db
		.select({ reportId: abuseReports.id, submissionId: abuseReports.submissionId, status: abuseReports.status, allegationCategory: abuseReports.allegationCategory, createdAt: abuseReports.createdAt })
		.from(abuseReports)
		.orderBy(desc(abuseReports.createdAt))
		.all()
		.map((report) => ({ ...report, targets: (targets.get(report.reportId) ?? []).map((target) => target.normalizedTarget) }));
}

export type ProviderDataset = { records: ProviderRouteRecord[]; reports: ReportSummary[] };

let cached: { at: number; dataset: Promise<ProviderDataset> } | undefined;

/** Every route record and report, shared by every request within the cache period. */
export function providerDataset(now = Date.now()): Promise<ProviderDataset> {
	if (!cached || now - cached.at > CACHE_MS) {
		const dataset = Promise.all([loadProviderRouteRecords(), loadReportSummaries()]).then(([records, reports]) => ({ records, reports }));
		cached = { at: now, dataset };
		// A failed load must not be served from the cache to later requests.
		dataset.catch(() => {
			if (cached?.dataset === dataset) cached = undefined;
		});
	}
	return cached.dataset;
}
