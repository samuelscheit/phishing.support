import { and, asc, eq, inArray, ne, notExists, sql } from "drizzle-orm";

import { abuseJobs, abuseReports, abuseTargets } from "../abuse/schema";
import { getDb } from "../db";
import { generateId } from "../db/ids";
import type { SiteCheckResult } from "./check";
import { siteChecks, type SiteCheck } from "./schema";

/** Every check, grouped by target and in the order it was made. */
export async function listSiteChecks(): Promise<SiteCheck[]> {
	const db = await getDb();
	return db.select().from(siteChecks).orderBy(asc(siteChecks.targetId), asc(siteChecks.checkedAt)).all();
}

/** The checks of these targets, grouped by target and in the order they were made. */
export async function listSiteChecksForTargets(targetIds: readonly bigint[]): Promise<SiteCheck[]> {
	if (!targetIds.length) return [];
	const db = await getDb();
	return db.select().from(siteChecks)
		.where(inArray(siteChecks.targetId, [...targetIds]))
		.orderBy(asc(siteChecks.targetId), asc(siteChecks.checkedAt))
		.all();
}

/** The checks of one report's targets, in the order they were made. */
export async function listSiteChecksForReport(reportId: bigint): Promise<SiteCheck[]> {
	const db = await getDb();
	return db.select().from(siteChecks).where(eq(siteChecks.reportId, reportId)).orderBy(asc(siteChecks.checkedAt)).all();
}

export async function recordSiteCheck(target: { reportId: bigint; targetId: bigint }, result: SiteCheckResult): Promise<SiteCheck> {
	const db = await getDb();
	return db.insert(siteChecks).values({ ...result, id: generateId(), reportId: target.reportId, targetId: target.targetId }).returning().get();
}

/** A target whose site is checked, with what its schedule needs. */
export type LivenessTarget = {
	targetId: bigint;
	reportId: bigint;
	/** The reported address that is visited: the target's first observed URL. */
	url: string;
	reportedAt: Date;
	lastCheckedAt?: Date;
};

const LIVENESS_JOB_KEY_PREFIX = "liveness:";

/** The dedupe key of a target's pending check: one at a time per target. */
export function livenessJobKey(targetId: bigint): string {
	return `${LIVENESS_JOB_KEY_PREFIX}${targetId.toString()}`;
}

/**
 * The targets whose site is checked: a resolved domain or IP target with an
 * observed URL, on a report that was not canceled. Emails, service accounts
 * and campaigns are no site to visit. `withoutPendingCheck` leaves out the
 * targets that already have a check queued or running.
 */
export async function listLivenessTargets(options: { targetId?: bigint; withoutPendingCheck?: boolean } = {}): Promise<LivenessTarget[]> {
	const db = await getDb();
	const lastCheckedAt = sql`(select max(${siteChecks.checkedAt}) from ${siteChecks} where ${siteChecks.targetId} = ${abuseTargets.id})`.mapWith(siteChecks.checkedAt);
	const rows = db.select({
		targetId: abuseTargets.id,
		reportId: abuseTargets.reportId,
		observedUrls: abuseTargets.observedUrls,
		reportedAt: abuseReports.createdAt,
		lastCheckedAt,
	})
		.from(abuseTargets)
		.innerJoin(abuseReports, eq(abuseReports.id, abuseTargets.reportId))
		.where(and(
			inArray(abuseTargets.targetType, ["domain", "ip"]),
			eq(abuseTargets.resolutionStatus, "resolved"),
			ne(abuseReports.status, "canceled"),
			sql`json_array_length(${abuseTargets.observedUrls}) > 0`,
			...(options.targetId === undefined ? [] : [eq(abuseTargets.id, options.targetId)]),
			...(options.withoutPendingCheck
				? [notExists(db.select({ id: abuseJobs.id }).from(abuseJobs).where(and(
					eq(abuseJobs.dedupeKey, sql`${LIVENESS_JOB_KEY_PREFIX} || ${abuseTargets.id}`),
					inArray(abuseJobs.status, ["queued", "running", "unknown_external_state"]),
				)))]
				: []),
		))
		.all();
	return rows.map(({ observedUrls, lastCheckedAt: last, ...row }) => ({
		...row,
		url: observedUrls[0]!,
		...(last ? { lastCheckedAt: last } : {}),
	}));
}
