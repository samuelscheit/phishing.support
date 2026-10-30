import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import type { ReporterMetadata } from "../../request_metadata";
import { submissions } from "../../db/schema";
import type { ValidatedAbuseReportRequest } from "../contracts";
import {
	abuseJobs,
	abuseProviderRoutes,
	abuseProviderRuns,
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
	/** The submission that owns this report, when it came from website/email analysis. */
	submissionId?: bigint;
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
			if (params.submissionId !== undefined && !idempotencyKey) {
				// The primary report remains idempotent by ownership. Derived backend
				// reports carry explicit stable idempotency keys and share the submission.
				const owned = tx.select({ id: abuseReports.id }).from(abuseReports).where(eq(abuseReports.submissionId, params.submissionId)).get();
				if (owned) return { reportId: owned.id, trackingToken, created: false };
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
					trackingTokenHash,
					idempotencyKey,
					requestPayloadHash: request.requestPayloadHash,
					allegationCategory: request.allegationCategory,
					description: request.description,
					legalBrandUrl: request.legalBrandUrl,
					reporterName: request.reporter?.name,
					reporterContactEmail: request.reporter?.email,
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
					metadata: { source: params.submissionId === undefined ? "public_api" : "submission", decodedMimeType: evidence.mimeType },
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

/** The report owned by a website/email submission, if analysis confirmed it. */
export async function getReportForSubmission(submissionId: bigint): Promise<AbuseReport | undefined> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.submissionId, submissionId)).orderBy(asc(abuseReports.createdAt)).get();
}

export async function listReportsForSubmission(submissionId: bigint): Promise<AbuseReport[]> {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.submissionId, submissionId)).orderBy(asc(abuseReports.createdAt)).all();
}

/** Primary report for every website submission, used to backfill supplementary discovery jobs. */
export async function listWebsiteReports() {
	const db = await getDb();
	const rows = await db
		.select({ reportId: abuseReports.id, submissionId: abuseReports.submissionId, createdAt: abuseReports.createdAt })
		.from(abuseReports)
		.innerJoin(submissions, eq(submissions.id, abuseReports.submissionId))
		.where(eq(submissions.kind, "website"))
		.orderBy(asc(abuseReports.createdAt))
		.all();
	const seen = new Set<bigint>();
	return rows.filter((row): row is typeof row & { submissionId: bigint } => {
		if (row.submissionId === null || seen.has(row.submissionId)) return false;
		seen.add(row.submissionId);
		return true;
	});
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

/** Submitted provider routes of the given providers, with the time their receipt was recorded. */
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
