import { and, asc, eq, exists, inArray, isNotNull, isNull, like, or } from "drizzle-orm";

import { getDb, type DbExecutor, type Transaction } from "../../db";
import { submissions } from "../../db/schema";
import { siteGroupOf } from "../../network/registered_domain";
import { generateId } from "../../db/ids";
import type { ReporterMetadata } from "../../http/reporter_headers";
import type { ValidatedAbuseReportRequest } from "../contracts";
import {
	jobs,
	abuseProviderRoutes,
	abuseProviderRuns,
	abuseReportCases,
	abuseReports,
	abuseTargets,
	type AbuseProviderRoute,
	type AbuseReport,
	type AbuseReportStatus,
} from "../schema";
import { AbuseInputError, createIdempotentTrackingToken, createTrackingToken, hashTrackingToken } from "../security/security";
import { listArtifacts } from "./artifacts";
import { insertQueuedJob } from "./jobs";
import { insertArtifact, now, recordEvent } from "./shared";
import { stableJson } from "../../util/hash";
import { siteChecks, TAKEN_DOWN_STATES } from "../../liveness/schema";
import { websiteSite } from "../../website/info/site";
import { DAY_MS } from "../../util/date_time";

function selectExistingIdempotentReport(tx: Transaction, idempotencyKey: string) {
	return tx
		.select({ id: abuseReports.id, requestPayloadHash: abuseReports.requestPayloadHash, trackingTokenHash: abuseReports.trackingTokenHash })
		.from(abuseReports)
		.where(eq(abuseReports.idempotencyKey, idempotencyKey))
		.get();
}

export type CreatedAbuseReport = {
	reportId: bigint;
	trackingToken: string;
	created: boolean;
	/** Set when the site already had an open report of another case, which now names this case too. */
	joined?: { submissionId: bigint };
};

/**
 * Reports a later case does not join: those that ended without reaching any
 * provider, and those an operator must still decide on, which may never be
 * sent. A later case reports their subject anew.
 */
const UNJOINABLE_REPORT_STATUSES = new Set<AbuseReportStatus>(["insufficient_evidence", "no_route", "failed", "canceled", "needs_human"]);
/**
 * How long a report stays the one report of its site for later cases. A host
 * that ignored it this long, or a site that came back after its takedown, is
 * reported again with the newer case's evidence.
 */
export const REPORT_JOIN_WINDOW_MS = 30 * DAY_MS;

/**
 * What a case's report is about, so that it is reported once across cases: a
 * later case that finds the same subject joins the open report of the case
 * that reported it first (`abuse_report_cases`) instead of a second report.
 * A report that ended unsent, awaits an operator, is older than the window,
 * or whose target our checks found taken down (the site is back), is
 * reported anew.
 */
export type ReportSubject =
	/**
	 * A website site: the case's primary report (no idempotency key) of the
	 * site's host; the window is REPORT_JOIN_WINDOW_MS. Another case joins an
	 * open report of any site of the same site group (`siteGroupOf`): one
	 * registrable domain is reported to its registrar once.
	 */
	| { site: string; group: string }
	/** A subject its reports name in their idempotency keys, `<key>:<submission id>`: a deceptive funnel's business and affiliate. */
	| { key: string; windowMs: number };

/** A website report's subject: the site its first URL names, and that site's group. */
export function websiteReportSubject(url: string): ReportSubject {
	return { site: websiteSite(url), group: siteGroupOf(url).key };
}

/** The site a report's target stands for: its first reported URL's, else its host. */
function targetSite(target: { normalizedTarget: string; observedUrls: string[] }): string {
	try {
		return target.observedUrls[0] ? websiteSite(target.observedUrls[0]) : target.normalizedTarget;
	} catch {
		return target.normalizedTarget;
	}
}

type SubjectReport = { id: bigint; submissionId: bigint | null; status: AbuseReportStatus; createdAt: Date; takenDown: boolean; site?: string };

const reportColumns = (tx: DbExecutor) => {
	const takedown = tx.select({ id: siteChecks.id }).from(siteChecks)
		.where(and(eq(siteChecks.reportId, abuseReports.id), inArray(siteChecks.state, [...TAKEN_DOWN_STATES])));
	return { id: abuseReports.id, submissionId: abuseReports.submissionId, status: abuseReports.status, createdAt: abuseReports.createdAt, takenDown: exists(takedown).mapWith(Boolean) };
};

/** The site group a report's target stands for. */
function targetGroup(target: { normalizedTarget: string; observedUrls: string[] }): string {
	try {
		return siteGroupOf(target.observedUrls[0] ?? `https://${target.normalizedTarget}/`).key;
	} catch {
		return target.normalizedTarget;
	}
}

/**
 * The website case reports of a site group, oldest first: the primary reports
 * (no idempotency key) whose site, named first, lies in the group, each with
 * its site and whether a check of ours confirmed its takedown.
 */
function siteGroupReports(tx: DbExecutor, group: string): SubjectReport[] {
	const host = group.split("/")[0]!;
	return tx
		.select({ ...reportColumns(tx), normalizedTarget: abuseTargets.normalizedTarget, observedUrls: abuseTargets.observedUrls })
		.from(abuseReports)
		.innerJoin(abuseTargets, eq(abuseTargets.reportId, abuseReports.id))
		// A website case's report names its site first and only; an email report names its sending IP second.
		.where(and(
			or(eq(abuseTargets.normalizedTarget, host), like(abuseTargets.normalizedTarget, `%.${host}`)),
			eq(abuseTargets.ordinal, 0),
			isNull(abuseReports.idempotencyKey),
			isNotNull(abuseReports.submissionId),
		))
		.orderBy(asc(abuseReports.createdAt))
		.all()
		.filter((candidate) => targetGroup(candidate) === group)
		.map((candidate) => ({ ...candidate, site: targetSite(candidate) }));
}

/** The case reports of a subject, oldest first, each with whether a check of ours confirmed its target's takedown. */
function subjectReports(tx: Transaction, subject: ReportSubject): SubjectReport[] {
	if ("key" in subject) {
		return tx.select(reportColumns(tx)).from(abuseReports)
			.where(and(like(abuseReports.idempotencyKey, `${subject.key}:%`), isNotNull(abuseReports.submissionId)))
			.orderBy(asc(abuseReports.createdAt))
			.all();
	}
	return siteGroupReports(tx, subject.group);
}

/** Whether a later case may join a report: open, not ended unsent, younger than the window. */
function joinable(candidate: SubjectReport, at: Date, windowMs: number): boolean {
	return !UNJOINABLE_REPORT_STATUSES.has(candidate.status) && !candidate.takenDown && at.getTime() - candidate.createdAt.getTime() < windowMs;
}

/**
 * The report that stands for a site group, which a host of the group is
 * collected into instead of visited: the oldest open one a later case may
 * join, else the newest one our checks found taken down (the registrar or
 * host acted on the group already). Undefined when the group has none.
 */
export async function siteGroupReport(group: string, at = new Date()): Promise<{ reportId: bigint; submissionId: bigint; takenDown: boolean } | undefined> {
	const candidates = siteGroupReports(await getDb(), group);
	const chosen = candidates.find((candidate) => joinable(candidate, at, REPORT_JOIN_WINDOW_MS)) ?? candidates.findLast((candidate) => candidate.takenDown);
	return chosen && { reportId: chosen.id, submissionId: chosen.submissionId!, takenDown: chosen.takenDown };
}

/**
 * The case report this one would duplicate: the case's own report of the
 * subject (a replayed analysis), or another case's open report of it within
 * the subject's window (another lure of the same kit, another link of the
 * same affiliate). Without a subject (an email), a case owns one report.
 */
function existingCaseReport(tx: Transaction, submissionId: bigint, request: ValidatedAbuseReportRequest, subject: ReportSubject | undefined, at: Date) {
	if (subject === undefined) {
		const owned = tx.select({ id: abuseReports.id }).from(abuseReports).where(and(eq(abuseReports.submissionId, submissionId), isNull(abuseReports.idempotencyKey))).get();
		return owned && { reportId: owned.id, ownerId: submissionId };
	}
	const candidates = subjectReports(tx, subject);
	// The case's own report of this very site; another site of its group it reported itself is a report of its own.
	const owned = candidates.find((candidate) => candidate.submissionId === submissionId && ("key" in subject || candidate.site === subject.site));
	if (owned) return { reportId: owned.id, ownerId: submissionId };
	const windowMs = "key" in subject ? subject.windowMs : REPORT_JOIN_WINDOW_MS;
	const open = candidates.find((candidate) => candidate.submissionId !== submissionId && joinable(candidate, at, windowMs));
	return open && { reportId: open.id, ownerId: open.submissionId! };
}

export async function createReport(params: {
	request: ValidatedAbuseReportRequest;
	reporter: ReporterMetadata;
	/** The submission that owns this report, when it came from website/email analysis. */
	submissionId?: bigint;
	/**
	 * What a case's report is about. A case reports each subject once, and a
	 * subject another case's open report covers is not reported again: that
	 * report is linked to this case instead.
	 */
	subject?: ReportSubject;
	/**
	 * Collect evidence before any provider is contacted: the report is held in
	 * `investigating` with this job queued instead of `resolve_report`, and
	 * `releaseInvestigatedReport` starts resolution once the evidence is in.
	 */
	investigation?: { payload: Record<string, unknown> };
	/**
	 * A criminal referral of a campaign: its routes are drafted for the
	 * operator's approval instead of resolved, so no first job is queued.
	 */
	campaignId?: bigint;
}): Promise<CreatedAbuseReport> {
	const db = await getDb();
	const { request, reporter } = params;
	const idempotencyKey = request.idempotencyKey;
	const trackingToken = idempotencyKey
		? createIdempotentTrackingToken(idempotencyKey, request.requestPayloadHash)
		: createTrackingToken();
	const trackingTokenHash = hashTrackingToken(trackingToken);

	return db.transaction(
		(tx) => {
			// A case's own reports stay idempotent by case and subject, also when a replayed analysis saw its chain
			// anew (other times, other evidence). Derived reports without a subject carry stable idempotency keys.
			if (params.submissionId !== undefined && (params.subject || !idempotencyKey)) {
				const existing = existingCaseReport(tx, params.submissionId, request, params.subject, now());
				if (existing?.ownerId === params.submissionId) return { reportId: existing.reportId, trackingToken, created: false };
				if (existing) {
					joinCase(tx, existing.reportId, params.submissionId, request.targets.flatMap((target) => target.observedUrls));
					return { reportId: existing.reportId, trackingToken, created: false, joined: { submissionId: existing.ownerId } };
				}
			}
			if (idempotencyKey) {
				const existing = selectExistingIdempotentReport(tx, idempotencyKey);
				if (existing) {
					if (existing.requestPayloadHash !== request.requestPayloadHash) {
						throw new AbuseInputError("This idempotency key was already used for a different report.");
					}
					if (existing.trackingTokenHash !== trackingTokenHash) {
						throw new Error("The stored idempotency record does not match its derived tracking token.");
					}
					return { reportId: existing.id, trackingToken, created: false };
				}
			}

			const reportId = generateId();
			const timestamp = now();
			tx.insert(abuseReports)
				.values({
					id: reportId,
					submissionId: params.submissionId,
					campaignId: params.campaignId,
					trackingTokenHash,
					idempotencyKey,
					requestPayloadHash: request.requestPayloadHash,
					allegationCategory: request.allegationCategory,
					description: request.description,
					legalBrandUrl: request.legalBrandUrl,
					reportedUserAgent: request.reportedUserAgent,
					reporterName: request.reporter?.name,
					reporterContactEmail: request.reporter?.email,
					status: params.investigation ? "investigating" : "accepted",
					requesterIp: reporter.reporterIp,
					requesterCountry: reporter.reporterCountry,
					requesterHeaders: reporter.reporterHeaders,
					createdAt: timestamp,
					updatedAt: timestamp,
				})
				.run();

			const targetIds = new Map<string, bigint>();
			for (const target of request.targets) {
				const targetId = generateId();
				targetIds.set(target.normalizedTarget, targetId);
				tx.insert(abuseTargets)
					.values({
						id: targetId,
						reportId,
						ordinal: target.ordinal,
						originalInput: target.originalInput,
						originalInputs: target.originalInputs,
						normalizedTarget: target.normalizedTarget,
						targetType: target.targetType,
						observedUrls: target.observedUrls,
						resolutionStatus: "pending",
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.run();
			}

			const requestArtifact = Buffer.from(stableJson(request.originalRequest), "utf8");
			insertArtifact(tx, {
				reportId,
				name: "original-request.json",
				kind: "original_request",
				mimeType: "application/json",
				buffer: requestArtifact,
			});
			for (const evidence of request.evidence) {
				insertArtifact(tx, {
					reportId,
					name: evidence.filename,
					kind: "user_evidence_original",
					mimeType: evidence.mimeType,
					buffer: evidence.buffer,
					metadata: { source: params.submissionId === undefined ? "public_api" : "submission", decodedMimeType: evidence.mimeType },
				});
			}

			recordEvent(tx, {
				reportId,
				eventType: "report.accepted",
				data: { targetCount: targetIds.size, evidenceCount: request.evidence.length },
			});
			if (params.campaignId !== undefined) return { reportId, trackingToken, created: true };

			insertQueuedJob(tx, params.investigation
				? { jobType: "investigate_report", reportId, payload: params.investigation.payload, dedupeKey: `investigate:${reportId.toString()}` }
				: { jobType: "resolve_report", reportId, dedupeKey: `resolve:${reportId.toString()}` });

			return { reportId, trackingToken, created: true };
		},
			{ behavior: "immediate" }
		);
	}

/** Link a case to another case's report of the same subject, once, with an event naming it on the report. */
function joinCase(tx: DbExecutor, reportId: bigint, submissionId: bigint, urls: readonly string[], data: Record<string, unknown> = {}): boolean {
	const linked = tx.insert(abuseReportCases)
		.values({ id: generateId(), reportId, submissionId, createdAt: now() })
		.onConflictDoNothing()
		.returning({ id: abuseReportCases.id })
		.get();
	if (!linked) return false;
	recordEvent(tx, { reportId, eventType: "report.case_joined", data: { submissionId: submissionId.toString(), urls: [...urls], ...data } });
	return true;
}

/**
 * Name a case a report covers without the case having been visited: a host
 * collected into its site group's report (website/visit_queue/collect.ts).
 */
export async function collectCaseIntoReport(reportId: bigint, submissionId: bigint, url: string): Promise<boolean> {
	const db = await getDb();
	return db.transaction((tx) => joinCase(tx, reportId, submissionId, [url], { collected: true }), { behavior: "immediate" });
}

/** Undo a collection: the case is visited on its own after all, so the report no longer names it. */
export async function releaseCollectedCase(reportId: bigint, submissionId: bigint): Promise<void> {
	const db = await getDb();
	db.transaction((tx) => {
		const left = tx.delete(abuseReportCases)
			.where(and(eq(abuseReportCases.reportId, reportId), eq(abuseReportCases.submissionId, submissionId)))
			.returning({ id: abuseReportCases.id })
			.get();
		if (left) recordEvent(tx, { reportId, eventType: "report.case_released", data: { submissionId: submissionId.toString() } });
	}, { behavior: "immediate" });
}

/**
 * The addresses of the other hosts of a report's site group that cases this
 * report names (collected or joined) were opened for, first seen first: what
 * the registrar is told besides the reported host.
 */
export async function listGroupHostUrls(reportId: bigint): Promise<string[]> {
	const db = await getDb();
	const target = db.select({ normalizedTarget: abuseTargets.normalizedTarget }).from(abuseTargets)
		.where(and(eq(abuseTargets.reportId, reportId), eq(abuseTargets.ordinal, 0))).get();
	if (!target) return [];
	const rows = db.select({ data: submissions.data }).from(abuseReportCases)
		.innerJoin(submissions, eq(submissions.id, abuseReportCases.submissionId))
		.where(eq(abuseReportCases.reportId, reportId))
		.orderBy(asc(abuseReportCases.createdAt))
		.all();
	const urls = new Map<string, string>();
	for (const { data } of rows) {
		const url = data.kind === "website" ? data.website.url : undefined;
		if (!url) continue;
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			continue;
		}
		if (host !== target.normalizedTarget && !urls.has(host)) urls.set(host, url);
	}
	return [...urls.values()];
}

/**
 * End a report's investigation: append the collected evidence to its
 * description and attachments, then queue provider resolution. Runs once;
 * a replayed investigation finds the report already released.
 */
export async function releaseInvestigatedReport(params: {
	reportId: bigint;
	/** Evidence sentences appended to the description providers receive. */
	findings: string[];
	evidence: Array<{ filename: string; mimeType: string; buffer: Buffer; metadata?: Record<string, unknown> }>;
}): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const report = tx.select().from(abuseReports).where(eq(abuseReports.id, params.reportId)).get();
			if (!report || report.status !== "investigating") return false;
			const timestamp = now();
			const description = [report.description, ...params.findings].join("\n").slice(0, 30_000);
			tx.update(abuseReports).set({ status: "accepted", description, updatedAt: timestamp }).where(eq(abuseReports.id, params.reportId)).run();
			for (const evidence of params.evidence) {
				insertArtifact(tx, {
					reportId: params.reportId,
					name: evidence.filename,
					kind: "user_evidence_original",
					mimeType: evidence.mimeType,
					buffer: evidence.buffer,
					metadata: { source: "investigation", decodedMimeType: evidence.mimeType, ...evidence.metadata },
				});
			}
			const { id: jobId } = insertQueuedJob(tx, { jobType: "resolve_report", reportId: params.reportId, dedupeKey: `resolve:${params.reportId.toString()}` });
			recordEvent(tx, {
				reportId: params.reportId,
				jobId,
				eventType: "report.investigated",
				data: { findingCount: params.findings.length, evidenceCount: params.evidence.length },
			});
			return true;
		},
		{ behavior: "immediate" },
	);
}

export async function getReport(reportId: bigint): Promise<AbuseReport | undefined> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.id, reportId)).get();
}

async function getReportByTrackingTokenHash(trackingTokenHash: string): Promise<AbuseReport | undefined> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.trackingTokenHash, trackingTokenHash)).get();
}

/**
 * The first report a case owns: an email case's only one, a website case's
 * first confirmed site's or funnel business's. A case may own several (one
 * per site and business, and those derived from them): see
 * listReportsForSubmission and, for those it joined, listJoinedReportsForSubmission.
 */
export async function getReportForSubmission(submissionId: bigint): Promise<AbuseReport | undefined> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.submissionId, submissionId)).orderBy(asc(abuseReports.createdAt)).get();
}

export async function listReportsForSubmission(submissionId: bigint): Promise<AbuseReport[]> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.submissionId, submissionId)).orderBy(asc(abuseReports.createdAt)).all();
}

/** Other cases' reports this case joined: the open report of a site it confirmed too, or of an affiliate its funnel led to. */
export async function listJoinedReportsForSubmission(submissionId: bigint): Promise<AbuseReport[]> {
	const db = await getDb();
	return db.select({ report: abuseReports }).from(abuseReportCases)
		.innerJoin(abuseReports, eq(abuseReports.id, abuseReportCases.reportId))
		.where(eq(abuseReportCases.submissionId, submissionId))
		.orderBy(asc(abuseReportCases.createdAt))
		.all()
		.map(({ report }) => report);
}

/** The cases that joined a report besides the one owning it, oldest first. */
export async function listJoinedCases(reportId: bigint): Promise<bigint[]> {
	const db = await getDb();
	return db.select({ submissionId: abuseReportCases.submissionId }).from(abuseReportCases)
		.where(eq(abuseReportCases.reportId, reportId))
		.orderBy(asc(abuseReportCases.createdAt))
		.all()
		.map(({ submissionId }) => submissionId);
}

export async function getReportByTrackingToken(token: string): Promise<AbuseReport | undefined> {
	return getReportByTrackingTokenHash(hashTrackingToken(token));
}

export async function listTargets(reportId: bigint) {
	const db = await getDb();
	return db.select().from(abuseTargets).where(eq(abuseTargets.reportId, reportId)).orderBy(asc(abuseTargets.ordinal)).all();
}

/** Add or refresh a code-derived target without duplicating it on job replay. */
export async function upsertDerivedTarget(params: {
	reportId: bigint;
	normalizedTarget: string;
	targetType: "domain" | "ip";
	observedUrls: string[];
	resolverSnapshot: Record<string, unknown>;
	disposition: string;
}) {
	const db = await getDb();
	return db.transaction((tx) => {
		const existing = tx
			.select()
			.from(abuseTargets)
			.where(and(eq(abuseTargets.reportId, params.reportId), eq(abuseTargets.normalizedTarget, params.normalizedTarget)))
			.get();
		const timestamp = now();
		if (existing) {
			if (existing.resolutionStatus === "pending") {
				tx.update(abuseTargets).set({
					observedUrls: params.observedUrls,
					resolutionStatus: "resolved",
					resolverSnapshot: params.resolverSnapshot,
					disposition: params.disposition,
					updatedAt: timestamp,
				}).where(eq(abuseTargets.id, existing.id)).run();
			}
			return tx.select().from(abuseTargets).where(eq(abuseTargets.id, existing.id)).get()!;
		}
		const maximum = tx.select({ ordinal: abuseTargets.ordinal }).from(abuseTargets)
			.where(eq(abuseTargets.reportId, params.reportId)).orderBy(asc(abuseTargets.ordinal)).all().at(-1)?.ordinal ?? -1;
		const id = generateId();
		tx.insert(abuseTargets).values({
			id,
			reportId: params.reportId,
			ordinal: maximum + 1,
			originalInput: params.normalizedTarget,
			originalInputs: [params.normalizedTarget],
			normalizedTarget: params.normalizedTarget,
			targetType: params.targetType,
			observedUrls: params.observedUrls,
			resolutionStatus: "resolved",
			resolverSnapshot: params.resolverSnapshot,
			disposition: params.disposition,
			createdAt: timestamp,
			updatedAt: timestamp,
		}).run();
		recordEvent(tx, {
			reportId: params.reportId,
			targetId: id,
			eventType: "target.derived",
			data: { normalizedTarget: params.normalizedTarget, disposition: params.disposition },
		});
		return tx.select().from(abuseTargets).where(eq(abuseTargets.id, id)).get()!;
	}, { behavior: "immediate" });
}

export async function listRoutes(reportId: bigint) {
	const db = await getDb();
	return db.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.reportId, reportId)).orderBy(asc(abuseProviderRoutes.createdAt)).all();
}

export async function getRoute(routeId: bigint): Promise<AbuseProviderRoute | undefined> {
	const db = await getDb();
	return db.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
}

export async function getTarget(targetId: bigint) {
	const db = await getDb();
	return db.select().from(abuseTargets).where(eq(abuseTargets.id, targetId)).get();
}

export async function getReportInput(reportId: bigint) {
	const report = await getReport(reportId);
	if (!report) return undefined;
	const targets = await listTargets(reportId);
	const artifacts = await listArtifacts(reportId, ["user_evidence_original"]);
	return { report, targets, evidenceArtifacts: artifacts };
}

/**
 * Compare-and-set only the report-level phases that exist before a route
 * transition can derive the aggregate.  Route outcomes use
 * `recomputeReportStatusInTransaction` instead, which makes a route's
 * durable state the single source of truth for public progress.
 */

export async function transitionReportStatus(params: {
	reportId: bigint;
	from: AbuseReportStatus | AbuseReportStatus[];
	to: AbuseReportStatus;
	data?: Record<string, unknown>;
}): Promise<boolean> {
	const db = await getDb();
	const expected = new Set(Array.isArray(params.from) ? params.from : [params.from]);
	return db.transaction(
		(tx) => {
			const report = tx.select({ status: abuseReports.status }).from(abuseReports).where(eq(abuseReports.id, params.reportId)).get();
			if (!report || !expected.has(report.status)) return false;
			if (report.status === params.to) return true;
			const updated = tx
				.update(abuseReports)
				.set({ status: params.to, updatedAt: now() })
				.where(and(eq(abuseReports.id, params.reportId), eq(abuseReports.status, report.status)))
				.returning({ id: abuseReports.id })
				.get();
			if (!updated) return false;
			recordEvent(tx, {
				reportId: params.reportId,
				eventType: "report.status_changed",
				data: { from: report.status, to: params.to, ...(params.data ?? {}) },
			});
			return true;
		},
		{ behavior: "immediate" }
	);
}

/** Submitted provider routes of the given providers, with the time their receipt was recorded. */
/** Provider runs whose submission may have reached the provider without an answer, with their routes. */
export async function listUnresolvedProviderRuns(providerRegistryKeys: string[]) {
	if (providerRegistryKeys.length === 0) return [];
	const db = await getDb();
	return db
		.select({ route: abuseProviderRoutes, run: abuseProviderRuns })
		.from(abuseProviderRoutes)
		.innerJoin(abuseProviderRuns, eq(abuseProviderRuns.routeId, abuseProviderRoutes.id))
		.where(and(
			eq(abuseProviderRoutes.status, "unknown_external_state"),
			eq(abuseProviderRuns.executionStatus, "unknown_external_state"),
			inArray(abuseProviderRoutes.providerRegistryKey, providerRegistryKeys),
		))
		.all();
}

export async function listSubmittedRoutesWithReceipt(providerRegistryKeys: string[]) {
	if (providerRegistryKeys.length === 0) return [];
	const db = await getDb();
	return db
		.select({ route: abuseProviderRoutes, submittedAt: abuseProviderRuns.createdAt })
		.from(abuseProviderRoutes)
		.innerJoin(abuseProviderRuns, eq(abuseProviderRuns.routeId, abuseProviderRoutes.id))
		.where(and(
			eq(abuseProviderRoutes.status, "submitted"),
			inArray(abuseProviderRoutes.providerRegistryKey, providerRegistryKeys),
			isNotNull(abuseProviderRuns.confirmationId),
		))
		.all();
}
