import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import type { ReporterMetadata } from "../../request_metadata";
import type { ValidatedAbuseReportRequest } from "../contracts";
import {
	abuseJobs,
	abuseProviderRoutes,
	abuseReports,
	abuseTargets,
	type AbuseProviderRoute,
	type AbuseReport,
	type AbuseReportStatus,
} from "../schema";
import {
	AbuseInputError,
	createIdempotentTrackingToken,
	createTrackingToken,
	hashTrackingToken,
	stableJson,
} from "../security";
import { listArtifacts } from "./artifacts";
import { insertArtifact, now, recordEvent } from "./shared";

function selectExistingIdempotentReport(tx: any, idempotencyKey: string) {
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
};

export async function createReport(params: {
	request: ValidatedAbuseReportRequest;
	reporter: ReporterMetadata;
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
					trackingTokenHash,
					idempotencyKey,
					requestPayloadHash: request.requestPayloadHash,
					allegationCategory: request.allegationCategory,
					description: request.description,
					legalBrandUrl: request.legalBrandUrl,
					reporterContactEmail: request.reporterContactEmail,
					reporterIdentity: request.reporterIdentity,
					status: "accepted",
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
					metadata: { source: "public_api", decodedMimeType: evidence.mimeType },
				});
			}

			const jobId = generateId();
			tx.insert(abuseJobs)
				.values({
					id: jobId,
					jobType: "resolve_report",
					reportId,
					payload: {},
					dedupeKey: `resolve:${reportId.toString()}`,
					status: "queued",
					retryCount: 0,
					nextAttemptAt: timestamp,
					unknownExternalState: false,
					createdAt: timestamp,
					updatedAt: timestamp,
				})
				.run();
			recordEvent(tx, {
				reportId,
				eventType: "report.accepted",
				data: { targetCount: targetIds.size, evidenceCount: request.evidence.length },
			});
			recordEvent(tx, { reportId, jobId, eventType: "job.queued", data: { jobType: "resolve_report" } });

			return { reportId, trackingToken, created: true };
		},
			{ behavior: "immediate" }
		);
	}

export async function getReport(reportId: bigint): Promise<AbuseReport | undefined> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.id, reportId)).get();
}

export async function getReportByTrackingTokenHash(trackingTokenHash: string): Promise<AbuseReport | undefined> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.trackingTokenHash, trackingTokenHash)).get();
}

/**
 * Find a report created by an internal handoff. The idempotency key is the
 * durable cross-aggregate link for those reports; unlike the private tracking
 * token it is safe for server-side read models to use and does not need to be
 * exposed to the browser.
 */
export async function getReportByIdempotencyKey(idempotencyKey: string): Promise<AbuseReport | undefined> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.idempotencyKey, idempotencyKey)).get();
}

export async function getReportByTrackingToken(token: string): Promise<AbuseReport | undefined> {
	return getReportByTrackingTokenHash(hashTrackingToken(token));
}

export async function listTargets(reportId: bigint) {
	const db = await getDb();
	return db.select().from(abuseTargets).where(eq(abuseTargets.reportId, reportId)).orderBy(asc(abuseTargets.ordinal)).all();
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

export async function setReportVerificationOutcome(reportId: bigint, verificationOutcome: Record<string, unknown>): Promise<void> {
	const db = await getDb();
	await db.update(abuseReports).set({ verificationOutcome, updatedAt: now() }).where(eq(abuseReports.id, reportId));
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

/**
 * Compatibility name for non-route phase updates. The operation itself is
 * still compare-and-set and never bypasses a terminal/canceled report.
 */

export async function setReportStatus(reportId: bigint, status: AbuseReportStatus, data: Record<string, unknown> = {}): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const report = tx.select({ status: abuseReports.status }).from(abuseReports).where(eq(abuseReports.id, reportId)).get();
			if (!report || report.status === status || report.status === "canceled" || ["submitted", "insufficient_evidence", "no_route", "needs_human"].includes(report.status)) return false;
			const updated = tx
				.update(abuseReports)
				.set({ status, updatedAt: now() })
				.where(and(eq(abuseReports.id, reportId), eq(abuseReports.status, report.status)))
				.returning({ id: abuseReports.id })
				.get();
			if (!updated) return false;
			recordEvent(tx, { reportId, eventType: "report.status_changed", data: { from: report.status, to: status, ...data } });
			return true;
		},
		{ behavior: "immediate" },
	);
}
