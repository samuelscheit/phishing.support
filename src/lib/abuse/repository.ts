import crypto from "node:crypto";

import { and, asc, desc, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";

import { getDb } from "../db";
import { generateId } from "../db/ids";
import type { ReporterMetadata } from "../request_metadata";
import type { DecodedEvidence, NormalizedAbuseTarget, ValidatedAbuseReportRequest } from "./contracts";
import {
	abuseArtifacts,
	abuseEvents,
	abuseJobs,
	abuseLocks,
	abuseMailCodes,
	abuseMailMessages,
	abuseProviderRoutes,
	abuseProviderRuns,
	abuseReports,
	abuseTargets,
	abuseWebhookEvents,
	type AbuseArtifact,
	type AbuseEvent,
	type AbuseJob,
	type AbuseJobStatus,
	type AbuseJobType,
	type AbuseMailClassification,
	type AbuseProviderRoute,
	type AbuseProviderRun,
	type AbuseReport,
	type AbuseReportStatus,
	type AbuseRouteStatus,
	type AbuseRunStatus,
} from "./schema";
import {
	AbuseInputError,
	createIdempotentTrackingToken,
	createTrackingToken,
	hashStableJson,
	hashTrackingToken,
	sha256Hex,
	safePublicError,
	stableJson,
} from "./security";

function now(): Date {
	return new Date();
}

function artifactValues(params: {
	reportId: bigint;
	name: string;
	kind: string;
	mimeType: string;
	buffer: Buffer;
	targetId?: bigint;
	routeId?: bigint;
	runId?: bigint;
	metadata?: Record<string, unknown>;
}) {
	return {
		id: generateId(),
		reportId: params.reportId,
		targetId: params.targetId,
		routeId: params.routeId,
		runId: params.runId,
		name: params.name,
		kind: params.kind,
		mimeType: params.mimeType,
		sha256: sha256Hex(params.buffer),
		size: params.buffer.byteLength,
		metadata: params.metadata,
		blob: params.buffer,
		createdAt: now(),
	};
}

function recordEvent(tx: any, params: {
	reportId: bigint;
	eventType: string;
	data?: Record<string, unknown>;
	targetId?: bigint;
	routeId?: bigint;
	runId?: bigint;
	jobId?: bigint;
}) {
	tx.insert(abuseEvents)
		.values({
			id: generateId(),
			reportId: params.reportId,
			targetId: params.targetId,
			routeId: params.routeId,
			runId: params.runId,
			jobId: params.jobId,
			eventType: params.eventType,
			data: params.data ?? {},
			createdAt: now(),
		})
		.run();
}

/**
 * Route status is the authoritative lifecycle record.  Keep the public
 * aggregate in the same transaction as every route transition so a delayed
 * worker cannot calculate a status from an obsolete route snapshot and write
 * it after a newer transition.  `canceled` is an explicit operational stop
 * and is never reopened by asynchronous work.
 */
function recomputeReportStatusInTransaction(
	tx: any,
	reportId: bigint,
	data: Record<string, unknown> = {},
): AbuseReportStatus | undefined {
	const report = tx.select({ status: abuseReports.status }).from(abuseReports).where(eq(abuseReports.id, reportId)).get();
	if (!report || report.status === "canceled") return report?.status as AbuseReportStatus | undefined;
	const routeStatuses = tx
		.select({ status: abuseProviderRoutes.status })
		.from(abuseProviderRoutes)
		.where(eq(abuseProviderRoutes.reportId, reportId))
		.all()
		.map((item: { status: AbuseRouteStatus }) => item.status);
	const aggregate = aggregateReportStatus(routeStatuses);
	// Route status intentionally has no separate `verifying` value. While a
	// GNAME verifier is still capturing evidence its route remains `resolving`,
	// so retain the report's more specific phase until a route lifecycle change
	// supplies a more informative aggregate.
	if (aggregate === "resolving" && report.status === "verifying") return report.status;
	if (report.status === aggregate) return aggregate;
	const timestamp = now();
	tx.update(abuseReports).set({ status: aggregate, updatedAt: timestamp }).where(eq(abuseReports.id, reportId)).run();
	recordEvent(tx, {
		reportId,
		eventType: "report.status_changed",
		data: { from: report.status, to: aggregate, ...data },
	});
	return aggregate;
}

function insertArtifact(tx: any, params: Parameters<typeof artifactValues>[0]): bigint {
	const values = artifactValues(params);
	tx.insert(abuseArtifacts).values(values).run();
	return values.id;
}

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

/**
 * Raised only after the inbound-message insert loses a uniqueness race.  It
 * carries no side effects: throwing from the transaction callback is
 * intentional so SQLite rolls back the raw MIME/attachment writes before the
 * existing row is looked up outside the transaction.
 */
class DuplicateInboundMailError extends Error {
	readonly code = "duplicate_inbound_abuse_mail";
}

/**
 * Once resolution has moved a route beyond its initial state, stale resolver
 * work must never rewrite its provider definition pin, delivery state, or
 * external-attempt provenance.  A deliberate re-resolution is a separate
 * operational action, not a side effect of retrying an old resolver job.
 */
const FINAL_OR_BLOCKED_ROUTE_STATUSES = new Set<AbuseRouteStatus>([
	"submitted",
	"acknowledged",
	"provider_rejected",
	"delivery_failed",
	"insufficient_evidence",
	"no_route",
	"failed",
	"needs_human",
	"unknown_external_state",
]);

/**
 * These route outcomes are immutable from normal asynchronous worker paths.
 * `delivery_failed` is deliberately absent because an explicit SMTP rejection
 * or correlated bounce can be retried with the same durable identity. Every
 * other terminal/blocked state must withstand a stale job finishing after a
 * newer job already settled the route.
 */
const IMMUTABLE_ROUTE_STATUSES = new Set<AbuseRouteStatus>([
	"submitted",
	"acknowledged",
	"provider_rejected",
	"insufficient_evidence",
	"no_route",
	"failed",
	"needs_human",
	"unknown_external_state",
]);

export type ResolvedRouteInput = {
	routeKey: string;
	providerRegistryKey: string;
	providerDisplayName: string;
	routeType: "email" | "skyvern_portal" | "manual_unroutable";
	verifiedEmail?: string;
	providerDefinitionVersion?: string;
	providerDefinitionHash?: string;
	resolverProvenance: Record<string, unknown>;
	resolutionSnapshot: Record<string, unknown>;
	verificationResult?: Record<string, unknown>;
	serviceIdentity?: Record<string, unknown>;
	status?: AbuseRouteStatus;
};

/**
 * The only persistence API used by standalone abuse reporting. It never reads
 * or writes the legacy submissions, analysis_runs, artifacts, or report tables.
 */
export class AbuseRepository {
	static async createReport(params: {
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

		static async getReport(reportId: bigint): Promise<AbuseReport | undefined> {
		const db = await getDb();
		return db.select().from(abuseReports).where(eq(abuseReports.id, reportId)).get();
	}

	static async getReportByTrackingTokenHash(trackingTokenHash: string): Promise<AbuseReport | undefined> {
		const db = await getDb();
		return db.select().from(abuseReports).where(eq(abuseReports.trackingTokenHash, trackingTokenHash)).get();
	}

	static async getReportByTrackingToken(token: string): Promise<AbuseReport | undefined> {
		return this.getReportByTrackingTokenHash(hashTrackingToken(token));
	}

	static async listTargets(reportId: bigint) {
		const db = await getDb();
		return db.select().from(abuseTargets).where(eq(abuseTargets.reportId, reportId)).orderBy(asc(abuseTargets.ordinal)).all();
	}

	static async listRoutes(reportId: bigint) {
		const db = await getDb();
		return db.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.reportId, reportId)).orderBy(asc(abuseProviderRoutes.createdAt)).all();
	}

	static async getRoute(routeId: bigint): Promise<AbuseProviderRoute | undefined> {
		const db = await getDb();
		return db.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
	}

	static async getTarget(targetId: bigint) {
		const db = await getDb();
		return db.select().from(abuseTargets).where(eq(abuseTargets.id, targetId)).get();
	}

	static async getReportInput(reportId: bigint) {
		const report = await this.getReport(reportId);
		if (!report) return undefined;
		const targets = await this.listTargets(reportId);
		const artifacts = await this.listArtifacts(reportId, ["user_evidence_original"]);
		return { report, targets, evidenceArtifacts: artifacts };
	}

	static async setReportVerificationOutcome(reportId: bigint, verificationOutcome: Record<string, unknown>): Promise<void> {
		const db = await getDb();
		await db.update(abuseReports).set({ verificationOutcome, updatedAt: now() }).where(eq(abuseReports.id, reportId));
	}

	/**
	 * Compare-and-set only the report-level phases that exist before a route
	 * transition can derive the aggregate.  Route outcomes use
	 * `recomputeReportStatusInTransaction` instead, which makes a route's
	 * durable state the single source of truth for public progress.
	 */
	static async transitionReportStatus(params: {
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
	static async setReportStatus(reportId: bigint, status: AbuseReportStatus, data: Record<string, unknown> = {}): Promise<boolean> {
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

	static async setTargetResolution(params: {
		targetId: bigint;
		status: "resolved" | "no_route" | "failed";
		resolverSnapshot?: Record<string, unknown>;
		disposition?: string;
	}): Promise<void> {
		const db = await getDb();
		db.transaction(
			(tx) => {
				const target = tx.select().from(abuseTargets).where(eq(abuseTargets.id, params.targetId)).get();
				if (!target) return;
				tx.update(abuseTargets)
					.set({
						resolutionStatus: params.status,
						resolverSnapshot: params.resolverSnapshot,
						disposition: params.disposition,
						updatedAt: now(),
					})
					.where(eq(abuseTargets.id, params.targetId))
					.run();
				recordEvent(tx, {
					reportId: target.reportId,
					targetId: target.id,
					eventType: "target.resolved",
					data: { status: params.status, disposition: params.disposition },
				});
			},
			{ behavior: "immediate" }
		);
	}

	static async upsertResolvedRoute(targetId: bigint, input: ResolvedRouteInput): Promise<AbuseProviderRoute> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const target = tx.select().from(abuseTargets).where(eq(abuseTargets.id, targetId)).get();
				if (!target) throw new Error(`Abuse target ${targetId.toString()} does not exist.`);
				const existing = tx
					.select()
					.from(abuseProviderRoutes)
					.where(and(eq(abuseProviderRoutes.targetId, targetId), eq(abuseProviderRoutes.routeKey, input.routeKey)))
					.get();
				const timestamp = now();
				if (existing) {
						// `providerDefinitionVersion` and `providerDefinitionHash` are route
						// pins. Never refresh them, or any other resolver-owned route field,
						// after a route has left initial resolution. Otherwise a stale retry
						// could silently bless a task created under a different definition.
						if (existing.status !== "resolving") return existing;
						tx.update(abuseProviderRoutes)
							.set({
							providerRegistryKey: input.providerRegistryKey,
							providerDisplayName: input.providerDisplayName,
							routeType: input.routeType,
							verifiedEmail: input.verifiedEmail,
							providerDefinitionVersion: input.providerDefinitionVersion,
							providerDefinitionHash: input.providerDefinitionHash,
							resolverProvenance: input.resolverProvenance,
							resolutionSnapshot: input.resolutionSnapshot,
							verificationResult: input.verificationResult,
							serviceIdentity: input.serviceIdentity,
								status: input.status ?? existing.status,
							updatedAt: timestamp,
						})
						.where(eq(abuseProviderRoutes.id, existing.id))
						.run();
					return tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, existing.id)).get()!;
				}
				const id = generateId();
				tx.insert(abuseProviderRoutes)
					.values({
						id,
						reportId: target.reportId,
						targetId,
						routeKey: input.routeKey,
						providerRegistryKey: input.providerRegistryKey,
						providerDisplayName: input.providerDisplayName,
						routeType: input.routeType,
						verifiedEmail: input.verifiedEmail,
						providerDefinitionVersion: input.providerDefinitionVersion,
						providerDefinitionHash: input.providerDefinitionHash,
						resolverProvenance: input.resolverProvenance,
						resolutionSnapshot: input.resolutionSnapshot,
						verificationResult: input.verificationResult,
						serviceIdentity: input.serviceIdentity,
						status: input.status ?? "resolving",
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.run();
				recordEvent(tx, {
					reportId: target.reportId,
					targetId,
					routeId: id,
					eventType: "route.resolved",
					data: { providerRegistryKey: input.providerRegistryKey, routeType: input.routeType, status: input.status ?? "resolving" },
				});
				return tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, id)).get()!;
			},
			{ behavior: "immediate" }
		);
	}

	/**
	 * Compare-and-set route lifecycle state. Worker jobs use this for every
	 * externally meaningful transition.  The aggregate is recalculated in the
	 * same SQLite transaction, so a stale worker cannot write an aggregate that
	 * was calculated from an earlier route snapshot.
	 */
	static async transitionRouteStatus(params: {
		routeId: bigint;
		from: AbuseRouteStatus | AbuseRouteStatus[];
		to: AbuseRouteStatus;
		data?: Record<string, unknown>;
	}): Promise<boolean> {
		const db = await getDb();
		const expected = new Set(Array.isArray(params.from) ? params.from : [params.from]);
		return db.transaction(
			(tx) => {
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!route || !expected.has(route.status)) return false;
				if (route.status !== params.to && IMMUTABLE_ROUTE_STATUSES.has(route.status)) return false;
				if (route.status !== params.to) {
					const updated = tx
						.update(abuseProviderRoutes)
						.set({ status: params.to, updatedAt: now() })
						.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, route.status)))
						.returning({ id: abuseProviderRoutes.id })
						.get();
					if (!updated) return false;
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						eventType: "route.status_changed",
						data: { from: route.status, to: params.to, ...(params.data ?? {}) },
					});
					recomputeReportStatusInTransaction(tx, route.reportId, {
						reason: "route_status_transition",
						routeId: route.id.toString(),
					});
				}
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/** Atomic route update for callers that do not need to name a predecessor. */
	static async setRouteStatus(
		routeId: bigint,
		status: AbuseRouteStatus,
		data: Record<string, unknown> = {},
		expectedFrom?: AbuseRouteStatus | AbuseRouteStatus[],
	): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
				if (!route || route.status === status || IMMUTABLE_ROUTE_STATUSES.has(route.status)) return false;
				if (expectedFrom !== undefined) {
					const expected = new Set(Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom]);
					if (!expected.has(route.status)) return false;
				}
				const updated = tx
					.update(abuseProviderRoutes)
					.set({ status, updatedAt: now() })
					.where(and(eq(abuseProviderRoutes.id, routeId), eq(abuseProviderRoutes.status, route.status)))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!updated) return false;
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId,
					eventType: "route.status_changed",
					data: { from: route.status, to: status, ...data },
				});
				recomputeReportStatusInTransaction(tx, route.reportId, { reason: "route_status_set", routeId: route.id.toString() });
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Atomically record an ambiguous external side effect.  The run, route,
	 * lifecycle events, and public aggregate are one durable transition; a
	 * caller must not update only one of those records and then throw.
	 */
	static async markUnknownExternalState(params: {
		routeId: bigint;
		runId?: bigint;
		error: string;
		reason?: string;
	}): Promise<void> {
		const db = await getDb();
		db.transaction(
			(tx) => {
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!route) return;
				// A stale external-call error must never downgrade a route that was
				// already safely settled by a webhook/reconciliation job. A known
				// delivery failure is also stronger than a late, ambiguous transport
				// error: an explicit SMTP rejection or correlated bounce is safe to
				// retry, whereas turning it into unknown_external_state would lose
				// that retry path.
				if (IMMUTABLE_ROUTE_STATUSES.has(route.status) || route.status === "delivery_failed") return;
				const timestamp = now();
				const error = params.error.slice(0, 2_000);
				if (params.runId !== undefined) {
					const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
					if (run) {
						tx.update(abuseProviderRuns)
							.set({ executionStatus: "unknown_external_state", failureReason: error, updatedAt: timestamp })
							.where(eq(abuseProviderRuns.id, run.id))
							.run();
						recordEvent(tx, {
							reportId: run.reportId,
							routeId: run.routeId,
							runId: run.id,
							eventType: "provider_run.unknown_external_state",
							data: { error, reason: params.reason },
						});
					}
				}
				if (route.status !== "unknown_external_state") {
					tx.update(abuseProviderRoutes)
						.set({ status: "unknown_external_state", updatedAt: timestamp })
						.where(eq(abuseProviderRoutes.id, route.id))
						.run();
				}
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: params.runId,
					eventType: "route.unknown_external_state",
					data: { from: route.status, error, reason: params.reason, operatorResolutionRequired: true },
				});

				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "unknown_external_state",
					routeId: route.id.toString(),
				});
			},
			{ behavior: "immediate" },
		);
	}

	static async setRouteVerification(
		routeId: bigint,
		verificationResult: Record<string, unknown>,
		serviceIdentity?: Record<string, unknown>,
		expectedStatus: AbuseRouteStatus = "resolving",
	): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const route = tx.select({ status: abuseProviderRoutes.status }).from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
				if (!route || route.status !== expectedStatus) return false;
				tx.update(abuseProviderRoutes)
					.set({ verificationResult, serviceIdentity, updatedAt: now() })
					.where(and(eq(abuseProviderRoutes.id, routeId), eq(abuseProviderRoutes.status, expectedStatus)))
					.run();
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	static async createProviderRun(params: {
		routeId: bigint;
		providerPayload: Record<string, unknown>;
		correlationKey?: string;
		executionStatus?: AbuseRunStatus;
	}): Promise<AbuseProviderRun & { created: boolean }> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!route) throw new Error(`Abuse provider route ${params.routeId.toString()} does not exist.`);
				const correlationKey = params.correlationKey ?? crypto.randomBytes(24).toString("hex");
				const existing = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, correlationKey)).get();
				if (existing) return { ...existing, created: false };
				const id = generateId();
				const timestamp = now();
				tx.insert(abuseProviderRuns)
					.values({
						id,
						reportId: route.reportId,
						routeId: route.id,
						providerPayload: params.providerPayload,
						payloadHash: hashStableJson(params.providerPayload),
						correlationKey,
						attemptCount: 0,
						executionStatus: params.executionStatus ?? "pending",
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: id,
					eventType: "provider_run.created",
					data: { payloadHash: hashStableJson(params.providerPayload), correlationKey },
				});
				return { ...tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, id)).get()!, created: true };
			},
			{ behavior: "immediate" }
		);
	}

	static async getProviderRun(runId: bigint): Promise<AbuseProviderRun | undefined> {
		const db = await getDb();
		return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, runId)).get();
	}

	static async getProviderRunBySkyvernRunId(skyvernRunId: string): Promise<AbuseProviderRun | undefined> {
		const db = await getDb();
		return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.skyvernRunId, skyvernRunId)).get();
	}

	static async getProviderRunByCorrelationKey(correlationKey: string): Promise<AbuseProviderRun | undefined> {
		const db = await getDb();
		return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, correlationKey)).get();
	}

	static async listProviderRunsForReport(reportId: bigint) {
		const db = await getDb();
		return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.reportId, reportId)).orderBy(desc(abuseProviderRuns.createdAt)).all();
	}

	static async getLatestProviderRunForRoute(routeId: bigint): Promise<AbuseProviderRun | undefined> {
		const db = await getDb();
		return db
			.select()
			.from(abuseProviderRuns)
			.where(eq(abuseProviderRuns.routeId, routeId))
			.orderBy(desc(abuseProviderRuns.createdAt))
			.limit(1)
			.get();
	}

	/** The one active external execution, if any, for code/mail correlation. */
	static async getLatestActiveProviderRunForRoute(routeId: bigint): Promise<AbuseProviderRun | undefined> {
		const db = await getDb();
		return db
			.select()
			.from(abuseProviderRuns)
			.where(
				and(
					eq(abuseProviderRuns.routeId, routeId),
						inArray(abuseProviderRuns.executionStatus, ["pending", "starting", "task_creation_started", "running", "waiting_code", "sending_code"]),
				),
			)
			.orderBy(desc(abuseProviderRuns.createdAt))
			.limit(1)
			.get();
	}

	static async updateProviderRun(runId: bigint, values: Partial<typeof abuseProviderRuns.$inferInsert>, eventType = "provider_run.updated"): Promise<void> {
		const db = await getDb();
		db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, runId)).get();
				if (!run) return;
				tx.update(abuseProviderRuns).set({ ...values, updatedAt: now() }).where(eq(abuseProviderRuns.id, runId)).run();
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: run.routeId,
					runId,
					eventType,
					data: Object.fromEntries(Object.entries(values).filter(([key]) => !["providerPayload"].includes(key))),
				});
			},
			{ behavior: "immediate" }
		);
	}

	/**
	 * Finish a known Skyvern run and its provider route in one transaction.
	 * Repeated webhooks and stale reconciliation jobs cannot downgrade an
	 * already-settled route when Skyvern later omits old output/artifacts.
	 */
	static async settleSkyvernRun(params: {
		runId: bigint;
		executionStatus: "completed" | "failed" | "canceled";
		routeStatus: "submitted" | "needs_human" | "failed";
		confirmationId?: string;
		confirmationText?: string;
		finalUrl?: string;
		submittedTargets?: string[];
		failureReason?: string;
		routeData?: Record<string, unknown>;
	}): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (!run) return false;
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || FINAL_OR_BLOCKED_ROUTE_STATUSES.has(route.status)) return false;

				const timestamp = now();
				tx.update(abuseProviderRuns)
					.set({
						executionStatus: params.executionStatus,
						confirmationId: params.confirmationId,
						confirmationText: params.confirmationText,
						finalUrl: params.finalUrl,
						submittedTargets: params.submittedTargets ?? [],
						failureReason: params.failureReason,
						updatedAt: timestamp,
					})
					.where(eq(abuseProviderRuns.id, run.id))
					.run();
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: run.routeId,
					runId: run.id,
					eventType: "provider_run.settled",
					data: {
						executionStatus: params.executionStatus,
						confirmationId: params.confirmationId,
						failureReason: params.failureReason,
					},
				});

				tx.update(abuseProviderRoutes)
					.set({ status: params.routeStatus, updatedAt: timestamp })
					.where(eq(abuseProviderRoutes.id, route.id))
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "route.status_changed",
					data: { from: route.status, to: params.routeStatus, ...(params.routeData ?? {}) },
				});

				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "skyvern_run_settled",
					routeId: route.id.toString(),
				});
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Atomically claim a route for an irreversible portal execution.  Creating
	 * the durable run record must happen only after this transition succeeds;
	 * otherwise two replayed jobs can both observe `queued` and each create an
	 * independent external task.
	 */
	static async beginPortalExecution(params: {
		routeId: bigint;
		providerPayload: Record<string, unknown>;
		correlationKey: string;
		expectedStatus: "queued" | "escalating_to_portal";
	}): Promise<{ run: AbuseProviderRun; created: boolean; resumed: boolean } | undefined> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!route || ![params.expectedStatus, "running"].includes(route.status)) return undefined;
				const existing = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, params.correlationKey)).get();
				if (existing && (existing.routeId !== route.id || existing.reportId !== route.reportId)) {
					throw new Error("Portal correlation key belongs to a different route.");
				}
				if (route.status === "running") {
					if (!existing) return undefined;
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						runId: existing.id,
						eventType: "provider_run.portal_execution_resumed",
						data: { correlationKey: params.correlationKey },
					});
					return { run: existing, created: false, resumed: true };
				}
				const timestamp = now();
				const updated = tx
					.update(abuseProviderRoutes)
					.set({ status: "running", updatedAt: timestamp })
					.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, params.expectedStatus)))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!updated) return undefined;
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					eventType: "route.status_changed",
					data: { from: route.status, to: "running", reason: "portal_execution_started" },
				});
				let run: AbuseProviderRun;
				let created = false;
				if (existing) {
					run = existing;
				} else {
					const id = generateId();
					tx.insert(abuseProviderRuns)
						.values({
							id,
							reportId: route.reportId,
							routeId: route.id,
							providerPayload: params.providerPayload,
							payloadHash: hashStableJson(params.providerPayload),
							correlationKey: params.correlationKey,
							attemptCount: 0,
							executionStatus: "starting",
							createdAt: timestamp,
							updatedAt: timestamp,
						})
						.run();
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						runId: id,
						eventType: "provider_run.created",
						data: { payloadHash: hashStableJson(params.providerPayload), correlationKey: params.correlationKey },
					});
					run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, id)).get()!;
					created = true;
				}
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "portal_execution_started",
					routeId: route.id.toString(),
				});
				return { run, created, resumed: false };
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * The first GNAME pilot shares one verification mailbox. Acquiring its lease
	 * and claiming the queued route must therefore be a single transaction: two
	 * replayed jobs for the same route otherwise share the deterministic lock
	 * owner and one can accidentally release the other job's reservation.
	 */
	static async beginGnamePortalExecution(params: {
		routeId: bigint;
		providerPayload?: Record<string, unknown>;
		correlationKey: string;
		lockKey: string;
		lockOwner: string;
		lockLeaseMs: number;
	}): Promise<
		| { acquired: true; run: AbuseProviderRun; created: boolean; resumed: boolean }
		| { acquired: false; reason: "route_not_eligible" | "active_route" | "lock_owned" | "missing_run" }
	> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!route || !["queued", "running"].includes(route.status)) return { acquired: false, reason: "route_not_eligible" as const };
				const activeOtherRoute = tx
					.select({ id: abuseProviderRoutes.id })
					.from(abuseProviderRoutes)
					.where(
						and(
							eq(abuseProviderRoutes.providerRegistryKey, "gname"),
							ne(abuseProviderRoutes.id, route.id),
							inArray(abuseProviderRoutes.status, ["running", "waiting_code", "unknown_external_state"]),
						),
					)
					.limit(1)
					.get();
				if (activeOtherRoute) return { acquired: false, reason: "active_route" as const };

				const existingRun = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, params.correlationKey)).get();
				if (existingRun && (existingRun.routeId !== route.id || existingRun.reportId !== route.reportId)) {
					throw new Error("GNAME portal correlation key belongs to a different route.");
				}
				if (route.status === "running" && !existingRun) return { acquired: false, reason: "missing_run" as const };

				const timestamp = now();
				const expiresAt = new Date(timestamp.getTime() + params.lockLeaseMs);
				const existingLock = tx.select().from(abuseLocks).where(eq(abuseLocks.lockKey, params.lockKey)).get();
				if (existingLock && existingLock.leaseExpiresAt > timestamp && existingLock.owner !== params.lockOwner) {
					return { acquired: false, reason: "lock_owned" as const };
				}
				if (existingLock) {
					tx.update(abuseLocks)
						.set({ owner: params.lockOwner, leaseExpiresAt: expiresAt, updatedAt: timestamp })
						.where(eq(abuseLocks.lockKey, params.lockKey))
						.run();
				} else {
					tx.insert(abuseLocks).values({ lockKey: params.lockKey, owner: params.lockOwner, leaseExpiresAt: expiresAt, updatedAt: timestamp }).run();
				}

				if (route.status === "queued") {
					const routeUpdated = tx
						.update(abuseProviderRoutes)
						.set({ status: "running", updatedAt: timestamp })
						.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "queued")))
						.returning({ id: abuseProviderRoutes.id })
						.get();
					if (!routeUpdated) throw new Error("GNAME route changed while its mailbox lease was being acquired.");
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						eventType: "route.status_changed",
						data: { from: "queued", to: "running", reason: "gname_mailbox_lock_and_portal_execution_started" },
					});
				} else {
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						runId: existingRun?.id,
						eventType: "provider_run.gname_portal_execution_resumed",
						data: { correlationKey: params.correlationKey },
					});
				}

				let run: AbuseProviderRun;
				let created = false;
				if (existingRun) {
					run = existingRun;
				} else {
					if (!params.providerPayload) throw new Error("A new GNAME portal run requires an immutable pre-task payload.");
					const id = generateId();
					tx.insert(abuseProviderRuns)
						.values({
							id,
							reportId: route.reportId,
							routeId: route.id,
						providerPayload: params.providerPayload,
						payloadHash: hashStableJson(params.providerPayload),
							correlationKey: params.correlationKey,
							attemptCount: 0,
							executionStatus: "starting",
							createdAt: timestamp,
							updatedAt: timestamp,
						})
						.run();
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						runId: id,
						eventType: "provider_run.created",
						data: { payloadHash: hashStableJson(params.providerPayload), correlationKey: params.correlationKey },
					});
					run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, id)).get()!;
					created = true;
				}
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "gname_mailbox_lock_and_portal_execution_started",
					routeId: route.id.toString(),
				});
				return { acquired: true, run, created, resumed: route.status === "running" };
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Replace a GNAME run's durable pre-task draft with the final immutable
	 * payload after SDK evidence uploads succeed but before task creation starts.
	 * This is intentionally the only mutable provider-payload transition: it is
	 * guarded by the no-external-task `starting` state and can happen once.
	 */
	static async prepareGnamePortalTaskPayload(params: { runId: bigint; providerPayload: Record<string, unknown> }): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (!run || run.executionStatus !== "starting" || run.skyvernRunId) return false;
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || route.status !== "running" || run.providerPayload.stage !== "evidence_upload_pending") return false;
				const timestamp = now();
				const updated = tx
					.update(abuseProviderRuns)
					.set({ providerPayload: params.providerPayload, payloadHash: hashStableJson(params.providerPayload), failureReason: null, updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting"), sql`${abuseProviderRuns.skyvernRunId} is null`))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!updated) return false;
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.gname_task_payload_prepared",
					data: { payloadHash: hashStableJson(params.providerPayload) },
				});
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Persist the pre-call boundary for one SDK evidence upload. Uploading a
	 * file is external work even though it is not the final provider complaint:
	 * if a worker dies after this marker, it cannot safely infer whether the SDK
	 * accepted the bytes and must never issue the same upload again.
	 */
	static async beginGnameEvidenceUpload(params: {
		runId: bigint;
		artifactId: string;
		sha256: string;
	}): Promise<"started" | "already_started" | "already_uploaded" | "not_eligible"> {
		if (!/^\d+$/.test(params.artifactId) || !/^[a-f0-9]{64}$/i.test(params.sha256)) return "not_eligible";
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (!run || run.executionStatus !== "starting" || run.skyvernRunId) return "not_eligible";
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || route.status !== "running") return "not_eligible";
				const payload = run.providerPayload;
				if (!payload || payload.stage !== "evidence_upload_pending" || !Array.isArray(payload.sourceArtifacts) || !Array.isArray(payload.evidenceUploads)) return "not_eligible";
				const source = payload.sourceArtifacts.find((value) => value && typeof value === "object" && !Array.isArray(value)
					&& (value as Record<string, unknown>).id === params.artifactId
					&& (value as Record<string, unknown>).sha256 === params.sha256);
				const uploadIndex = payload.evidenceUploads.findIndex((value) => value && typeof value === "object" && !Array.isArray(value)
					&& (value as Record<string, unknown>).artifactId === params.artifactId
					&& (value as Record<string, unknown>).sha256 === params.sha256);
				if (!source || uploadIndex < 0) return "not_eligible";
				const existing = payload.evidenceUploads[uploadIndex] as Record<string, unknown>;
				if (existing.state === "upload_started") return "already_started";
				if (existing.state === "uploaded") return "already_uploaded";
				if (existing.state !== "pending") return "not_eligible";
				const timestamp = now();
				const nextPayload = JSON.parse(stableJson(payload)) as Record<string, unknown>;
				const nextUploads = nextPayload.evidenceUploads as Array<Record<string, unknown>>;
				nextUploads[uploadIndex] = {
					artifactId: params.artifactId,
					sha256: params.sha256.toLowerCase(),
					state: "upload_started",
					startedAt: timestamp.toISOString(),
				};
				const updated = tx
					.update(abuseProviderRuns)
					.set({ providerPayload: nextPayload, payloadHash: hashStableJson(nextPayload), failureReason: null, updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting"), sql`${abuseProviderRuns.skyvernRunId} is null`))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!updated) return "not_eligible";
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.gname_evidence_upload_started",
					data: { artifactId: params.artifactId, sha256: params.sha256.toLowerCase() },
				});
				return "started";
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Checkpoint the exact SDK URL after an evidence upload succeeds. The URL is
	 * retained only in the route-owned payload because it authorizes browser
	 * retrieval; events intentionally record no signed URL material.
	 */
	static async recordGnameEvidenceUpload(params: {
		runId: bigint;
		artifactId: string;
		sha256: string;
		presignedUrl: string;
		expiresAt: Date;
	}): Promise<boolean> {
		if (!/^\d+$/.test(params.artifactId) || !/^[a-f0-9]{64}$/i.test(params.sha256)
			|| params.presignedUrl.length > 8_192 || !Number.isFinite(params.expiresAt.getTime())) return false;
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (!run || run.executionStatus !== "starting" || run.skyvernRunId) return false;
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || route.status !== "running") return false;
				const payload = run.providerPayload;
				if (!payload || payload.stage !== "evidence_upload_pending" || !Array.isArray(payload.sourceArtifacts) || !Array.isArray(payload.evidenceUploads)) return false;
				const source = payload.sourceArtifacts.find((value) => value && typeof value === "object" && !Array.isArray(value)
					&& (value as Record<string, unknown>).id === params.artifactId
					&& (value as Record<string, unknown>).sha256 === params.sha256);
				const uploadIndex = payload.evidenceUploads.findIndex((value) => value && typeof value === "object" && !Array.isArray(value)
					&& (value as Record<string, unknown>).artifactId === params.artifactId
					&& (value as Record<string, unknown>).sha256 === params.sha256
					&& (value as Record<string, unknown>).state === "upload_started");
				if (!source || uploadIndex < 0) return false;
				const timestamp = now();
				if (params.expiresAt <= timestamp) return false;
				const nextPayload = JSON.parse(stableJson(payload)) as Record<string, unknown>;
				const nextUploads = nextPayload.evidenceUploads as Array<Record<string, unknown>>;
				nextUploads[uploadIndex] = {
					artifactId: params.artifactId,
					sha256: params.sha256.toLowerCase(),
					state: "uploaded",
					presignedUrl: params.presignedUrl,
					uploadedAt: timestamp.toISOString(),
					expiresAt: params.expiresAt.toISOString(),
				};
				const updated = tx
					.update(abuseProviderRuns)
					.set({ providerPayload: nextPayload, payloadHash: hashStableJson(nextPayload), failureReason: null, updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting"), sql`${abuseProviderRuns.skyvernRunId} is null`))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!updated) return false;
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.gname_evidence_upload_recorded",
					data: { artifactId: params.artifactId, sha256: params.sha256.toLowerCase(), expiresAt: params.expiresAt.toISOString() },
				});
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Before the first evidence-upload pre-call marker, local setup failures can
	 * safely return a route to the queue. Once an upload has started, this method
	 * deliberately refuses to requeue: replaying an SDK upload after a crash or
	 * lost response could duplicate external provider storage work.
	 */
	static async requeueGnamePortalPreparation(params: { runId: bigint; error: string }): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (!run || run.executionStatus !== "starting" || run.skyvernRunId) return false;
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || route.status !== "running") return false;
				const uploads = run.providerPayload && Array.isArray(run.providerPayload.evidenceUploads)
					? run.providerPayload.evidenceUploads
					: undefined;
				if (!uploads || uploads.some((upload) => !upload || typeof upload !== "object" || Array.isArray(upload) || (upload as Record<string, unknown>).state !== "pending")) return false;
				const timestamp = now();
				const error = params.error.slice(0, 2_000);
				const routeUpdated = tx
					.update(abuseProviderRoutes)
					.set({ status: "queued", updatedAt: timestamp })
					.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "running")))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!routeUpdated) return false;
				tx.update(abuseProviderRuns)
					.set({ failureReason: error, updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting"), sql`${abuseProviderRuns.skyvernRunId} is null`))
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "route.status_changed",
					data: { from: "running", to: "queued", reason: "gname_task_preparation_retry", error },
				});
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "gname_task_preparation_retry",
					routeId: route.id.toString(),
				});
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Claim an email send attempt before constructing MIME or crossing SMTP.
	 * A delivery_failed route is the only retryable predecessor, and its prior
	 * durable run is returned so the sender can retain the same reply identity.
	 */
	static async beginEmailDelivery(params: {
		routeId: bigint;
		providerPayload: Record<string, unknown>;
		correlationKey: string;
	}): Promise<{ run: AbuseProviderRun; created: boolean; previousDeliveryFailed: boolean } | undefined> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!route || !["verified", "delivery_failed"].includes(route.status)) return undefined;
				const priorStatus = route.status;
				const existing = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, params.correlationKey)).get();
				// A route newly verified for SMTP must not inherit an unrelated old
				// attempt. Only the explicit delivery_failed retry path may reuse its
				// durable reply identity and correlation key.
				if (existing && priorStatus !== "delivery_failed") return undefined;
				const timestamp = now();
				const updated = tx
					.update(abuseProviderRoutes)
					.set({ status: "running", updatedAt: timestamp })
					.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, priorStatus)))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!updated) return undefined;
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					eventType: "route.status_changed",
					data: { from: priorStatus, to: "running", reason: "email_delivery_started" },
				});
				let run: AbuseProviderRun;
				let created = false;
				if (existing) {
					// `delivery_failed` is reached only after an explicit SMTP rejection
					// or a correlated bounce. It is the one safe retry path: retain the
					// exact correlation/reply identity while making this local attempt
					// visibly active again before another MIME message is persisted.
					tx.update(abuseProviderRuns)
						.set({ executionStatus: "starting", failureReason: null, updatedAt: timestamp })
						.where(eq(abuseProviderRuns.id, existing.id))
						.run();
					run = { ...existing, executionStatus: "starting", failureReason: null, updatedAt: timestamp };
				} else {
					const id = generateId();
					tx.insert(abuseProviderRuns)
						.values({
							id,
							reportId: route.reportId,
							routeId: route.id,
							providerPayload: params.providerPayload,
							payloadHash: hashStableJson(params.providerPayload),
							correlationKey: params.correlationKey,
							attemptCount: 0,
							executionStatus: "starting",
							createdAt: timestamp,
							updatedAt: timestamp,
						})
						.run();
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						runId: id,
						eventType: "provider_run.created",
						data: { payloadHash: hashStableJson(params.providerPayload), correlationKey: params.correlationKey },
					});
					run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, id)).get()!;
					created = true;
				}
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "email_delivery_started",
					routeId: route.id.toString(),
				});
				return { run, created, previousDeliveryFailed: priorStatus === "delivery_failed" };
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Persist a durable marker immediately before calling Skyvern's task-create
	 * endpoint. The immutable payload must have been saved already. A restart
	 * after this marker but before a task ID is known is intentionally ambiguous
	 * and must fail closed rather than create a duplicate provider complaint.
	 */
	static async prepareSkyvernTaskCreation(runId: bigint): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, runId)).get();
				if (!run || run.executionStatus !== "starting" || run.skyvernRunId) return false;
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || route.status !== "running") return false;
				const timestamp = now();
				const updated = tx
					.update(abuseProviderRuns)
					.set({ executionStatus: "task_creation_started", updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting"), sql`${abuseProviderRuns.skyvernRunId} is null`))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!updated) return false;
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.skyvern_task_creation_started",
				});
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Persist the task ID returned by Skyvern and the corresponding route phase
	 * together. A response that is lost before this transaction is deliberately
	 * handled as `unknown_external_state` by the caller instead of creating a
	 * second task.
	 */
	static async recordSkyvernTaskStarted(params: {
		runId: bigint;
		skyvernRunId: string;
		routeStatus: "running" | "waiting_code";
	}): Promise<boolean> {
		if (!/^[A-Za-z0-9._:-]{1,256}$/.test(params.skyvernRunId)) throw new Error("Skyvern returned an invalid run ID.");
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (!run || run.executionStatus !== "task_creation_started") return false;
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || route.status !== "running") return false;
				const timestamp = now();
				const runUpdated = tx
					.update(abuseProviderRuns)
					.set({
						skyvernRunId: params.skyvernRunId,
						executionStatus: params.routeStatus === "waiting_code" ? "waiting_code" : "running",
						attemptCount: run.attemptCount + 1,
						updatedAt: timestamp,
					})
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "task_creation_started")))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!runUpdated) return false;
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.skyvern_task_started",
					data: { skyvernRunId: params.skyvernRunId, executionStatus: params.routeStatus === "waiting_code" ? "waiting_code" : "running" },
				});
				if (params.routeStatus === "waiting_code") {
					const routeUpdated = tx
						.update(abuseProviderRoutes)
						.set({ status: "waiting_code", updatedAt: timestamp })
						.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "running")))
						.returning({ id: abuseProviderRoutes.id })
						.get();
					if (!routeUpdated) throw new Error("Skyvern task was created after the route left its running state.");
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						runId: run.id,
						eventType: "route.status_changed",
						data: { from: "running", to: "waiting_code", reason: "skyvern_task_started" },
					});
				}
				const reconciliationDedupeKey = `reconcile:${run.id.toString()}:${params.skyvernRunId}`;
				const existingReconciliation = tx
					.select({ id: abuseJobs.id })
					.from(abuseJobs)
					.where(
						and(
							eq(abuseJobs.dedupeKey, reconciliationDedupeKey),
							inArray(abuseJobs.status, ["queued", "running", "unknown_external_state"]),
						),
					)
					.get();
				if (!existingReconciliation) {
					const jobId = generateId();
					tx.insert(abuseJobs)
						.values({
							id: jobId,
							jobType: "reconcile_skyvern_run",
							reportId: run.reportId,
							routeId: route.id,
							runId: run.id,
							payload: { skyvernRunId: params.skyvernRunId },
							dedupeKey: reconciliationDedupeKey,
							status: "queued",
							retryCount: 0,
							nextAttemptAt: new Date(timestamp.getTime() + 5_000),
							unknownExternalState: false,
							createdAt: timestamp,
							updatedAt: timestamp,
						})
						.run();
					recordEvent(tx, {
						reportId: run.reportId,
						routeId: route.id,
						runId: run.id,
						jobId,
						eventType: "job.queued",
						data: { jobType: "reconcile_skyvern_run", skyvernRunId: params.skyvernRunId },
					});
				}
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "skyvern_task_started",
					routeId: route.id.toString(),
				});
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Settle a known SMTP outcome and its route in one compare-and-set
	 * transaction. This prevents a late bounce, a duplicate classifier, or a
	 * lease-replayed sender from overwriting a newer email lifecycle state.
	 */
	static async settleEmailDelivery(params: {
		runId: bigint;
		expectedRunStatus: "starting" | "delivered";
		expectedRouteStatus: "running" | "awaiting_provider_reply";
		outcome: "sent" | "failed";
		failureReason?: string;
	}): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (!run || run.executionStatus !== params.expectedRunStatus) return false;
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || route.status !== params.expectedRouteStatus) return false;
				const timestamp = now();
				const nextRunStatus: AbuseRunStatus = params.outcome === "sent" ? "delivered" : "failed";
				const nextRouteStatus: AbuseRouteStatus = params.outcome === "sent" ? "awaiting_provider_reply" : "delivery_failed";
				const runUpdated = tx
					.update(abuseProviderRuns)
					.set({ executionStatus: nextRunStatus, failureReason: params.failureReason, attemptCount: run.attemptCount + 1, updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, params.expectedRunStatus)))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!runUpdated) return false;
				const routeUpdated = tx
					.update(abuseProviderRoutes)
					.set({ status: nextRouteStatus, updatedAt: timestamp })
					.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, params.expectedRouteStatus)))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!routeUpdated) throw new Error("Email delivery settled after the route left its expected state.");
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.email_settled",
					data: { from: run.executionStatus, to: nextRunStatus, failureReason: params.failureReason },
				});
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "route.status_changed",
					data: { from: route.status, to: nextRouteStatus, reason: "email_delivery_settled", failureReason: params.failureReason },
				});
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "email_delivery_settled",
					routeId: route.id.toString(),
				});
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * An error while building MIME, storing a local artifact/message, or
	 * recording an explicit SMTP rejection is known to have occurred before a
	 * provider accepted the message.  Recover that narrow, safe class of error
	 * atomically: a claimed route must never remain `running` with a `starting`
	 * run after a local failure, and any pending local message is deliberately
	 * marked failed before a retry reuses the route's correlation identity.
	 */
	static async recoverEmailPreparationFailure(params: {
		runId: bigint;
		error: string;
	}): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				if (!run || run.executionStatus !== "starting") return false;
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || route.status !== "running") return false;
				const timestamp = now();
				const error = params.error.slice(0, 2_000);

				// A pending outbound record is local proof that SMTP was not yet
				// invoked by this code path. Marking it failed keeps the next attempt
				// unambiguously safe and preserves the same reply identity if one was
				// already generated.
				tx.update(abuseMailMessages)
					.set({ status: "failed", error, occurredAt: timestamp, updatedAt: timestamp })
					.where(
						and(
							eq(abuseMailMessages.runId, run.id),
							eq(abuseMailMessages.direction, "outbound"),
							eq(abuseMailMessages.status, "pending"),
						),
					)
					.run();

				const runUpdated = tx
					.update(abuseProviderRuns)
					.set({ executionStatus: "failed", failureReason: error, updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting")))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!runUpdated) return false;
				const routeUpdated = tx
					.update(abuseProviderRoutes)
					.set({ status: "delivery_failed", updatedAt: timestamp })
					.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "running")))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!routeUpdated) throw new Error("Safe email preparation failure settled after the route left running.");
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.email_preparation_failed",
					data: { error },
				});
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "route.status_changed",
					data: { from: "running", to: "delivery_failed", reason: "email_preparation_failed", error },
				});
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "email_preparation_failed",
					routeId: route.id.toString(),
				});
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Settle an inbound bounce against the exact persisted outbound RFC message.
	 *
	 * SMTP acceptance and route settlement intentionally happen in separate
	 * operations because the canonical outbound MIME must be retained before the
	 * network call. A fast bounce can therefore be ingested after outbound mail
	 * is marked `sent` while the route is still `running` and the run remains
	 * `starting`. This transaction accepts both that pre-settlement state and
	 * the ordinary delivered/awaiting-provider-reply state, so the sender can
	 * finish harmlessly without overwriting the evidence of a real bounce.
	 */
	static async settleCorrelatedEmailBounce(params: {
		inboundMessageId: bigint;
		failureReason?: string;
		retryAfterMs?: number;
	}): Promise<{ settled: boolean; routeId?: bigint; runId?: bigint; outboundMessageId?: bigint }> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const inbound = tx.select().from(abuseMailMessages).where(eq(abuseMailMessages.id, params.inboundMessageId)).get();
				if (!inbound || inbound.direction !== "inbound") return { settled: false };
				const identifiers = [...new Set([inbound.inReplyTo, ...inbound.references].filter((value): value is string => Boolean(value)))];
				if (identifiers.length === 0) return { settled: false };
				const matches = tx
					.select()
					.from(abuseMailMessages)
					.where(
						and(
							eq(abuseMailMessages.routeId, inbound.routeId),
							eq(abuseMailMessages.direction, "outbound"),
							inArray(abuseMailMessages.messageId, identifiers),
						),
					)
					.orderBy(desc(abuseMailMessages.createdAt))
					.limit(2)
					.all();
				if (matches.length !== 1) return { settled: false };
				const outbound = matches[0]!;
				if (!outbound.runId) return { settled: false };
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, outbound.runId)).get();
				if (!run || run.routeId !== inbound.routeId || !["starting", "delivered"].includes(run.executionStatus)) return { settled: false };
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
				if (!route || !["running", "awaiting_provider_reply"].includes(route.status)) return { settled: false };

				const timestamp = now();
				const error = (params.failureReason ?? "Provider bounce received.").slice(0, 2_000);
				const outboundUpdated = tx
					.update(abuseMailMessages)
					.set({ status: "failed", error, occurredAt: timestamp, updatedAt: timestamp })
					.where(
						and(
							eq(abuseMailMessages.id, outbound.id),
							inArray(abuseMailMessages.status, ["pending", "sent"]),
						),
					)
					.returning({ id: abuseMailMessages.id })
					.get();
				if (!outboundUpdated) return { settled: false };
				const runUpdated = tx
					.update(abuseProviderRuns)
					.set({ executionStatus: "failed", failureReason: error, updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), inArray(abuseProviderRuns.executionStatus, ["starting", "delivered"])))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!runUpdated) throw new Error("Correlated bounce settled after the email run changed state.");
				const routeUpdated = tx
					.update(abuseProviderRoutes)
					.set({ status: "delivery_failed", updatedAt: timestamp })
					.where(and(eq(abuseProviderRoutes.id, route.id), inArray(abuseProviderRoutes.status, ["running", "awaiting_provider_reply"])))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!routeUpdated) throw new Error("Correlated bounce settled after the email route changed state.");
				recordEvent(tx, {
					reportId: run.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.email_bounced",
					data: { inboundMessageId: inbound.id.toString(), outboundMessageId: outbound.id.toString(), error },
				});
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "route.status_changed",
					data: { from: route.status, to: "delivery_failed", reason: "provider_bounce", inboundMessageId: inbound.id.toString() },
				});

				const dedupeKey = `email-retry:${route.id.toString()}:${inbound.id.toString()}`;
				const existingRetry = tx
					.select({ id: abuseJobs.id })
					.from(abuseJobs)
					.where(
						and(
							eq(abuseJobs.dedupeKey, dedupeKey),
							inArray(abuseJobs.status, ["queued", "running", "unknown_external_state"]),
						),
					)
					.get();
				if (!existingRetry) {
					const jobId = generateId();
					tx.insert(abuseJobs)
						.values({
							id: jobId,
							jobType: "send_email",
							reportId: route.reportId,
							routeId: route.id,
							payload: { retryReason: "provider_bounce", bouncedOutboundMessageId: outbound.id.toString(), inboundMessageId: inbound.id.toString() },
							dedupeKey,
							status: "queued",
							retryCount: 0,
							nextAttemptAt: new Date(timestamp.getTime() + (params.retryAfterMs ?? 60_000)),
							unknownExternalState: false,
							createdAt: timestamp,
							updatedAt: timestamp,
						})
						.run();
					recordEvent(tx, {
						reportId: route.reportId,
						routeId: route.id,
						runId: run.id,
						jobId,
						eventType: "job.queued",
						data: { jobType: "send_email", reason: "provider_bounce", inboundMessageId: inbound.id.toString() },
					});
				}
				recomputeReportStatusInTransaction(tx, route.reportId, {
					reason: "provider_bounce",
					routeId: route.id.toString(),
				});
				return { settled: true, routeId: route.id, runId: run.id, outboundMessageId: outbound.id };
			},
			{ behavior: "immediate" },
		);
	}

	static async saveArtifact(params: Parameters<typeof artifactValues>[0]): Promise<bigint> {
		const db = await getDb();
		return db.transaction((tx) => insertArtifact(tx, params), { behavior: "immediate" });
	}

	static async listArtifacts(reportId: bigint, kinds?: string[]): Promise<AbuseArtifact[]> {
		const db = await getDb();
		const where = kinds?.length ? and(eq(abuseArtifacts.reportId, reportId), inArray(abuseArtifacts.kind, kinds)) : eq(abuseArtifacts.reportId, reportId);
		return db.select().from(abuseArtifacts).where(where).orderBy(asc(abuseArtifacts.createdAt)).all();
	}

	static async getArtifact(reportId: bigint, artifactId: bigint): Promise<AbuseArtifact | undefined> {
		const db = await getDb();
		return db.select().from(abuseArtifacts).where(and(eq(abuseArtifacts.reportId, reportId), eq(abuseArtifacts.id, artifactId))).get();
	}

	static async getArtifactById(artifactId: bigint): Promise<AbuseArtifact | undefined> {
		const db = await getDb();
		return db.select().from(abuseArtifacts).where(eq(abuseArtifacts.id, artifactId)).get();
	}

	static async enqueueJob(params: {
		jobType: AbuseJobType;
		reportId: bigint;
		routeId?: bigint;
		runId?: bigint;
		payload?: Record<string, unknown>;
		dedupeKey?: string;
		nextAttemptAt?: Date;
	}): Promise<AbuseJob> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				if (params.dedupeKey) {
					const existing = tx
						.select()
						.from(abuseJobs)
						.where(
							and(
								eq(abuseJobs.dedupeKey, params.dedupeKey),
								inArray(abuseJobs.status, ["queued", "running", "unknown_external_state"]),
							),
						)
						.get();
					if (existing) return existing;
				}
				const id = generateId();
				const timestamp = now();
				tx.insert(abuseJobs)
					.values({
						id,
						jobType: params.jobType,
						reportId: params.reportId,
						routeId: params.routeId,
						runId: params.runId,
						payload: params.payload ?? {},
						dedupeKey: params.dedupeKey,
						status: "queued",
						retryCount: 0,
						nextAttemptAt: params.nextAttemptAt ?? timestamp,
						unknownExternalState: false,
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.run();
				recordEvent(tx, { reportId: params.reportId, routeId: params.routeId, runId: params.runId, jobId: id, eventType: "job.queued", data: { jobType: params.jobType } });
				return tx.select().from(abuseJobs).where(eq(abuseJobs.id, id)).get()!;
			},
			{ behavior: "immediate" }
		);
	}

	/** Atomically leases one due job, never allowing two active jobs for a route. */
	static async claimNextJob(owner: string, leaseMs: number): Promise<AbuseJob | undefined> {
		const db = await getDb();
		const timestamp = now();
		const leaseExpiresAt = new Date(timestamp.getTime() + leaseMs);
		return db.transaction(
			(tx) => {
				const candidates = tx
					.select()
					.from(abuseJobs)
					.where(
						or(
							and(eq(abuseJobs.status, "queued"), lte(abuseJobs.nextAttemptAt, timestamp)),
							and(eq(abuseJobs.status, "running"), lte(abuseJobs.leaseExpiresAt, timestamp), eq(abuseJobs.unknownExternalState, false)),
						),
					)
					.orderBy(asc(abuseJobs.nextAttemptAt), asc(abuseJobs.createdAt))
					.limit(32)
					.all();
				for (const candidate of candidates) {
					if (candidate.routeId) {
						const active = tx
							.select({ id: abuseJobs.id })
							.from(abuseJobs)
							.where(
								and(
									eq(abuseJobs.routeId, candidate.routeId),
									eq(abuseJobs.status, "running"),
									gt(abuseJobs.leaseExpiresAt, timestamp),
								),
							)
							.get();
						if (active) continue;
					}
					tx.update(abuseJobs)
						.set({ status: "running", leaseOwner: owner, leaseExpiresAt, updatedAt: timestamp })
						.where(eq(abuseJobs.id, candidate.id))
						.run();
					recordEvent(tx, {
						reportId: candidate.reportId!,
						routeId: candidate.routeId ?? undefined,
						runId: candidate.runId ?? undefined,
						jobId: candidate.id,
						eventType: "job.claimed",
						data: { owner },
					});
					return tx.select().from(abuseJobs).where(eq(abuseJobs.id, candidate.id)).get();
				}
				return undefined;
			},
			{ behavior: "immediate" }
		);
	}

	static async renewJobLease(jobId: bigint, owner: string, leaseMs: number): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const job = tx.select({ status: abuseJobs.status, leaseOwner: abuseJobs.leaseOwner }).from(abuseJobs).where(eq(abuseJobs.id, jobId)).get();
				if (!job || job.status !== "running" || job.leaseOwner !== owner) return false;
				tx.update(abuseJobs)
					.set({ leaseExpiresAt: new Date(Date.now() + leaseMs), updatedAt: now() })
					.where(eq(abuseJobs.id, jobId))
					.run();
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	static async completeJob(jobId: bigint, owner: string): Promise<void> {
		const db = await getDb();
		db.transaction(
			(tx) => {
				const job = tx.select().from(abuseJobs).where(eq(abuseJobs.id, jobId)).get();
				if (!job || job.leaseOwner !== owner) return;
				tx.update(abuseJobs)
					.set({ status: "completed", leaseOwner: null, leaseExpiresAt: null, unknownExternalState: false, updatedAt: now() })
					.where(eq(abuseJobs.id, jobId))
					.run();
				recordEvent(tx, { reportId: job.reportId!, routeId: job.routeId ?? undefined, runId: job.runId ?? undefined, jobId, eventType: "job.completed" });
			},
			{ behavior: "immediate" }
		);
	}

	static async retryJob(params: { jobId: bigint; owner: string; error: string; afterMs: number }): Promise<void> {
		const db = await getDb();
		db.transaction(
			(tx) => {
				const job = tx.select().from(abuseJobs).where(eq(abuseJobs.id, params.jobId)).get();
				if (!job || job.leaseOwner !== params.owner) return;
				tx.update(abuseJobs)
					.set({
						status: "queued",
						leaseOwner: null,
						leaseExpiresAt: null,
						retryCount: job.retryCount + 1,
						nextAttemptAt: new Date(Date.now() + params.afterMs),
						lastError: params.error,
						updatedAt: now(),
					})
					.where(eq(abuseJobs.id, params.jobId))
					.run();
				recordEvent(tx, {
					reportId: job.reportId!,
					routeId: job.routeId ?? undefined,
					runId: job.runId ?? undefined,
					jobId: job.id,
					eventType: "job.retried",
					data: { retryCount: job.retryCount + 1, error: params.error },
				});
			},
			{ behavior: "immediate" }
		);
	}

	static async markJobUnknownExternalState(params: { jobId: bigint; owner: string; error: string }): Promise<void> {
		const db = await getDb();
		db.transaction(
			(tx) => {
				const job = tx.select().from(abuseJobs).where(eq(abuseJobs.id, params.jobId)).get();
				if (!job || job.leaseOwner !== params.owner) return;
				tx.update(abuseJobs)
					.set({
						status: "unknown_external_state",
						leaseOwner: null,
						leaseExpiresAt: null,
						unknownExternalState: true,
						lastError: params.error,
						updatedAt: now(),
					})
					.where(eq(abuseJobs.id, params.jobId))
					.run();
				recordEvent(tx, {
					reportId: job.reportId!,
					routeId: job.routeId ?? undefined,
					runId: job.runId ?? undefined,
					jobId: job.id,
					eventType: "job.unknown_external_state",
					data: { error: params.error },
				});
			},
			{ behavior: "immediate" }
		);
	}

	/** Finish a retry-exhausted local job without misrepresenting it as an external ambiguity. */
	static async failJob(params: { jobId: bigint; owner: string; error: string }): Promise<void> {
		const db = await getDb();
		db.transaction(
			(tx) => {
				const job = tx.select().from(abuseJobs).where(eq(abuseJobs.id, params.jobId)).get();
				if (!job || job.leaseOwner !== params.owner) return;
				tx.update(abuseJobs)
					.set({
						status: "failed",
						leaseOwner: null,
						leaseExpiresAt: null,
						lastError: params.error,
						updatedAt: now(),
					})
					.where(eq(abuseJobs.id, params.jobId))
					.run();
				recordEvent(tx, {
					reportId: job.reportId!,
					routeId: job.routeId ?? undefined,
					runId: job.runId ?? undefined,
					jobId: job.id,
					eventType: "job.failed",
					data: { error: params.error, retryCount: job.retryCount },
				});
			},
			{ behavior: "immediate" },
		);
	}

	static async recoverStaleJobs(): Promise<number> {
		const db = await getDb();
		const timestamp = now();
		return db.transaction(
			(tx) => {
				const stale = tx
					.select()
					.from(abuseJobs)
					.where(and(eq(abuseJobs.status, "running"), lte(abuseJobs.leaseExpiresAt, timestamp)))
					.all();
				for (const job of stale) {
					const status: AbuseJobStatus = job.unknownExternalState ? "unknown_external_state" : "queued";
					tx.update(abuseJobs)
						.set({ status, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: timestamp, updatedAt: timestamp })
						.where(eq(abuseJobs.id, job.id))
						.run();
					recordEvent(tx, {
						reportId: job.reportId!,
						routeId: job.routeId ?? undefined,
						runId: job.runId ?? undefined,
						jobId: job.id,
						eventType: job.unknownExternalState ? "job.recovery_requires_reconciliation" : "job.lease_recovered",
					});
				}
				return stale.length;
			},
			{ behavior: "immediate" }
		);
	}

	static async tryAcquireLock(lockKey: string, owner: string, leaseMs: number): Promise<boolean> {
		const db = await getDb();
		const timestamp = now();
		const expires = new Date(timestamp.getTime() + leaseMs);
		return db.transaction(
			(tx) => {
				const existing = tx.select().from(abuseLocks).where(eq(abuseLocks.lockKey, lockKey)).get();
				if (existing && existing.leaseExpiresAt > timestamp && existing.owner !== owner) return false;
				if (existing) {
					tx.update(abuseLocks).set({ owner, leaseExpiresAt: expires, updatedAt: timestamp }).where(eq(abuseLocks.lockKey, lockKey)).run();
				} else {
					tx.insert(abuseLocks).values({ lockKey, owner, leaseExpiresAt: expires, updatedAt: timestamp }).run();
				}
				return true;
			},
			{ behavior: "immediate" }
		);
	}

	static async releaseLock(lockKey: string, owner: string): Promise<void> {
		const db = await getDb();
		await db.delete(abuseLocks).where(and(eq(abuseLocks.lockKey, lockKey), eq(abuseLocks.owner, owner)));
	}

	/** Extends a lock only when this route still owns it. */
	static async renewLock(lockKey: string, owner: string, leaseMs: number): Promise<boolean> {
		const db = await getDb();
		const timestamp = now();
		const result = await db
			.update(abuseLocks)
			.set({ leaseExpiresAt: new Date(timestamp.getTime() + leaseMs), updatedAt: timestamp })
			.where(and(eq(abuseLocks.lockKey, lockKey), eq(abuseLocks.owner, owner)))
			.returning({ lockKey: abuseLocks.lockKey })
			.get();
		return Boolean(result);
	}

	/**
	 * Atomically owns or renews the shared GNAME verification-mailbox lease.
	 * The lock alone is not enough: a process outage can let a lease expire
	 * while an external GNAME task is still waiting for mail.  Therefore the
	 * durable active-route state is checked in the same transaction before a
	 * different route can take the lease.  An `unknown_external_state` route
	 * deliberately blocks later GNAME runs until operations resolve it.
	 */
	static async acquireOrRenewGnameMailboxLock(params: {
		routeId: bigint;
		lockKey: string;
		owner: string;
		leaseMs: number;
		markRouteRunning?: boolean;
	}): Promise<{ acquired: boolean; reason?: "route_missing" | "active_route" | "lock_owned" }> {
		const db = await getDb();
		const timestamp = now();
		const expiresAt = new Date(timestamp.getTime() + params.leaseMs);
		return db.transaction(
			(tx) => {
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!route) return { acquired: false, reason: "route_missing" as const };
				const activeOtherRoute = tx
					.select({ id: abuseProviderRoutes.id })
					.from(abuseProviderRoutes)
					.where(
						and(
							eq(abuseProviderRoutes.providerRegistryKey, "gname"),
							ne(abuseProviderRoutes.id, params.routeId),
							inArray(abuseProviderRoutes.status, ["running", "waiting_code", "unknown_external_state"]),
						),
					)
					.limit(1)
					.get();
				if (activeOtherRoute) return { acquired: false, reason: "active_route" as const };

				const existing = tx.select().from(abuseLocks).where(eq(abuseLocks.lockKey, params.lockKey)).get();
				if (existing && existing.leaseExpiresAt > timestamp && existing.owner !== params.owner) {
					return { acquired: false, reason: "lock_owned" as const };
				}
				if (existing) {
					tx.update(abuseLocks)
						.set({ owner: params.owner, leaseExpiresAt: expiresAt, updatedAt: timestamp })
						.where(eq(abuseLocks.lockKey, params.lockKey))
						.run();
				} else {
					tx.insert(abuseLocks).values({ lockKey: params.lockKey, owner: params.owner, leaseExpiresAt: expiresAt, updatedAt: timestamp }).run();
				}
				if (params.markRouteRunning && route.status !== "running") {
					tx.update(abuseProviderRoutes).set({ status: "running", updatedAt: timestamp }).where(eq(abuseProviderRoutes.id, route.id)).run();
					recordEvent(tx, {
						reportId: route.reportId,
						targetId: route.targetId,
						routeId: route.id,
						eventType: "route.status_changed",
						data: { from: route.status, to: "running", reason: "gname_mailbox_lock_acquired" },
					});
				}
				return { acquired: true };
			},
			{ behavior: "immediate" },
		);
	}

	static async createOutboundMail(params: {
		reportId: bigint;
		routeId: bigint;
		runId: bigint;
		fromAddress: string;
		toAddresses: string[];
		subject: string;
		textBody: string;
		messageId: string;
		replyAddress: string;
		correlationKey: string;
		rawArtifactId: bigint;
		attachmentArtifactIds: bigint[];
	}): Promise<bigint> {
		const db = await getDb();
		const id = generateId();
		await db.insert(abuseMailMessages).values({
			id,
			reportId: params.reportId,
			routeId: params.routeId,
			runId: params.runId,
			direction: "outbound",
			kind: "report",
			status: "pending",
			fromAddress: params.fromAddress,
			toAddresses: params.toAddresses,
			subject: params.subject,
			textBody: params.textBody,
			messageId: params.messageId,
			replyAddress: params.replyAddress,
			correlationKey: params.correlationKey,
			rawArtifactId: params.rawArtifactId,
			attachmentArtifactIds: params.attachmentArtifactIds.map(String),
			processingAttempts: 0,
			occurredAt: now(),
			createdAt: now(),
			updatedAt: now(),
		});
		return id;
	}

	/**
	 * Settle an outbound MIME record without allowing a late sender completion
	 * to overwrite a correlated delivery failure. A successful SMTP return may
	 * race an inbound bounce, so `sent` is legal only from `pending`; a known
	 * failure can supersede either pre-send or sent state.
	 */
	static async settleOutboundMail(params: { messageId: bigint; status: "sent" | "failed"; error?: string }): Promise<boolean> {
		const db = await getDb();
		const expected = params.status === "sent" ? ["pending"] : ["pending", "sent"];
		const updated = await db
			.update(abuseMailMessages)
			.set({ status: params.status, error: params.error, occurredAt: now(), updatedAt: now() })
			.where(
				and(
					eq(abuseMailMessages.id, params.messageId),
					eq(abuseMailMessages.direction, "outbound"),
					inArray(abuseMailMessages.status, expected),
				),
			)
			.returning({ id: abuseMailMessages.id })
			.get();
		return Boolean(updated);
	}

	static async listActiveGnameRoutes(): Promise<AbuseProviderRoute[]> {
		const db = await getDb();
		return db
			.select()
			.from(abuseProviderRoutes)
			.where(and(eq(abuseProviderRoutes.providerRegistryKey, "gname"), inArray(abuseProviderRoutes.status, ["running", "waiting_code", "unknown_external_state"])))
			.orderBy(asc(abuseProviderRoutes.updatedAt))
			.all();
	}

	static async getOutboundMailForRun(runId: bigint) {
		const db = await getDb();
		return db
			.select()
			.from(abuseMailMessages)
			.where(and(eq(abuseMailMessages.runId, runId), eq(abuseMailMessages.direction, "outbound")))
			.orderBy(desc(abuseMailMessages.createdAt))
			.limit(1)
			.get();
	}

	static async findInboundRoute(params: { recipients: string[]; inReplyTo?: string; references?: string[] }) {
		const db = await getDb();
		const candidateRouteIds = new Set<bigint>();
		if (params.recipients.length > 0) {
			const byReplyAddress = await db
				.select({ routeId: abuseMailMessages.routeId })
				.from(abuseMailMessages)
				.where(and(eq(abuseMailMessages.direction, "outbound"), inArray(abuseMailMessages.replyAddress, params.recipients)));
			for (const row of byReplyAddress) candidateRouteIds.add(row.routeId);
		}
		const refs = [...new Set([params.inReplyTo, ...(params.references ?? [])].filter((value): value is string => Boolean(value)))];
		if (refs.length > 0) {
			const byMessageId = await db
				.select({ routeId: abuseMailMessages.routeId })
				.from(abuseMailMessages)
				.where(and(eq(abuseMailMessages.direction, "outbound"), inArray(abuseMailMessages.messageId, refs)));
			for (const row of byMessageId) candidateRouteIds.add(row.routeId);
		}
		if (candidateRouteIds.size !== 1) return undefined;
		const routeId = [...candidateRouteIds][0];
		return db.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
	}

	static async getWaitingCodeRoute(): Promise<AbuseProviderRoute | undefined> {
		const db = await getDb();
		const routes = await db
			.select()
			.from(abuseProviderRoutes)
			.where(and(eq(abuseProviderRoutes.providerRegistryKey, "gname"), eq(abuseProviderRoutes.status, "waiting_code")))
			.orderBy(asc(abuseProviderRoutes.updatedAt))
			.limit(2);
		return routes.length === 1 ? routes[0] : undefined;
	}

	/**
	 * Persist one inbound IMAP delivery and every associated permanent artifact
	 * in one transaction. The IMAP UID ledger is checked before any artifact is
	 * written, so a repeated delivery cannot leave orphan raw-MIME or attachment
	 * records behind. RFC Message-ID is also checked in the same transaction to
	 * cover a provider copying one message to a different UID/mailbox.
	 */
	static async persistInboundMailWithArtifacts(params: {
		reportId: bigint;
		routeId: bigint;
		kind: string;
		fromAddress?: string;
		toAddresses: string[];
		subject?: string;
		textBody?: string;
		messageId?: string;
		inReplyTo?: string;
		references?: string[];
		mailbox: string;
		uidValidity: number;
		uid: number;
		rawMime: { name: string; buffer: Buffer; metadata?: Record<string, unknown> };
		attachments: Array<{ name: string; mimeType: string; buffer: Buffer; metadata?: Record<string, unknown> }>;
		occurredAt?: Date;
		}): Promise<{ id: bigint; created: boolean }> {
			const db = await getDb();
			try {
				return db.transaction(
			(tx) => {
				if (!Number.isSafeInteger(params.uidValidity) || params.uidValidity <= 0 || !Number.isSafeInteger(params.uid) || params.uid <= 0) {
					throw new Error("Inbound abuse mail requires a positive IMAP UID and UIDVALIDITY.");
				}
				const existing = tx
					.select({ id: abuseMailMessages.id })
					.from(abuseMailMessages)
					.where(
						and(
							eq(abuseMailMessages.imapMailbox, params.mailbox),
							eq(abuseMailMessages.imapUidValidity, params.uidValidity),
							eq(abuseMailMessages.imapUid, params.uid),
						),
					)
					.get();
				if (existing) return { id: existing.id, created: false };
				if (params.messageId) {
					const existingMessage = tx
						.select({ id: abuseMailMessages.id })
						.from(abuseMailMessages)
						.where(and(eq(abuseMailMessages.direction, "inbound"), eq(abuseMailMessages.messageId, params.messageId)))
						.get();
					if (existingMessage) return { id: existingMessage.id, created: false };
				}

				const rawArtifactId = insertArtifact(tx, {
					reportId: params.reportId,
					routeId: params.routeId,
					name: params.rawMime.name,
					kind: "inbound_mail_mime",
					mimeType: "message/rfc822",
					buffer: params.rawMime.buffer,
					metadata: params.rawMime.metadata,
				});
				const attachmentArtifactIds = params.attachments.map((attachment) =>
					insertArtifact(tx, {
						reportId: params.reportId,
						routeId: params.routeId,
						name: attachment.name,
						kind: "inbound_mail_attachment",
						mimeType: attachment.mimeType,
						buffer: attachment.buffer,
						metadata: attachment.metadata,
					}),
				);
				const id = generateId();
				const timestamp = now();
				const inserted = tx
					.insert(abuseMailMessages)
					.values({
						id,
						reportId: params.reportId,
						routeId: params.routeId,
						direction: "inbound",
						kind: params.kind,
						status: "received",
						fromAddress: params.fromAddress,
						toAddresses: params.toAddresses,
						subject: params.subject,
						textBody: params.textBody,
						messageId: params.messageId,
						inReplyTo: params.inReplyTo,
						references: params.references ?? [],
						rawArtifactId,
						attachmentArtifactIds: attachmentArtifactIds.map(String),
						imapMailbox: params.mailbox,
						imapUidValidity: params.uidValidity,
						imapUid: params.uid,
						processingAttempts: 0,
						occurredAt: params.occurredAt ?? timestamp,
						createdAt: timestamp,
						updatedAt: timestamp,
					})
					.onConflictDoNothing()
					.returning({ id: abuseMailMessages.id })
					.get();
				if (!inserted) throw new DuplicateInboundMailError("Inbound abuse mail uniqueness race.");
				recordEvent(tx, { reportId: params.reportId, routeId: params.routeId, eventType: "mail.inbound_received", data: { kind: params.kind } });
				return { id: inserted.id, created: true };
				},
				{ behavior: "immediate" },
				);
			} catch (error) {
			if (!(error instanceof DuplicateInboundMailError)) throw error;
			const existingByUid = await this.getInboundMailByImap({ mailbox: params.mailbox, uidValidity: params.uidValidity, uid: params.uid });
			const existingByMessageId = params.messageId ? await this.getInboundMailByMessageId(params.messageId) : undefined;
			const existing = existingByUid ?? existingByMessageId;
			if (!existing) throw new Error("Inbound abuse mail uniqueness conflict could not be reconciled.");
			return { id: existing.id, created: false };
			}
	}

	static async getMailMessage(messageId: bigint) {
		const db = await getDb();
		return db.select().from(abuseMailMessages).where(eq(abuseMailMessages.id, messageId)).get();
	}

	static async getInboundMailByImap(params: { mailbox: string; uidValidity: number; uid: number }) {
		const db = await getDb();
		return db
			.select()
			.from(abuseMailMessages)
			.where(
				and(
					eq(abuseMailMessages.direction, "inbound"),
					eq(abuseMailMessages.imapMailbox, params.mailbox),
					eq(abuseMailMessages.imapUidValidity, params.uidValidity),
					eq(abuseMailMessages.imapUid, params.uid),
				),
			)
			.get();
	}

	static async getInboundMailByMessageId(messageId: string) {
		const db = await getDb();
		return db
			.select()
			.from(abuseMailMessages)
			.where(and(eq(abuseMailMessages.direction, "inbound"), eq(abuseMailMessages.messageId, messageId)))
			.limit(1)
			.get();
	}

	static async setMailClassification(messageId: bigint, classification: AbuseMailClassification, extractedLinks: string[], disposition?: string): Promise<void> {
		const db = await getDb();
		await db
			.update(abuseMailMessages)
			.set({ classification, extractedLinks, disposition, processingAttempts: sql`${abuseMailMessages.processingAttempts} + 1`, updatedAt: now() })
			.where(eq(abuseMailMessages.id, messageId));
	}

	static async createMailCode(params: { reportId: bigint; routeId: bigint; runId?: bigint; mailMessageId: bigint; code: string; correlationKey?: string }): Promise<bigint> {
		const db = await getDb();
		const id = generateId();
		await db.insert(abuseMailCodes).values({
			id,
			reportId: params.reportId,
			routeId: params.routeId,
			runId: params.runId,
			mailMessageId: params.mailMessageId,
			codeHash: sha256Hex(params.code),
			correlationKey: params.correlationKey,
			status: "received",
			createdAt: now(),
		});
		return id;
	}

	/**
	 * Set the durable pre-side-effect marker for a shared-mailbox verification
	 * code. On recovery a run left in `sending_code` is ambiguous and must be
	 * resolved rather than automatically delivered again.
	 */
	static async prepareTotpDelivery(params: {
		routeId: bigint;
		runId: bigint;
		mailMessageId: bigint;
		code: string;
		correlationKey?: string;
	}): Promise<{ state: "prepared"; mailCodeId: bigint } | { state: "already_started" }> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!run || !route || run.routeId !== route.id) throw new Error("Provider run is not owned by the GNAME route.");
				if (route.status !== "waiting_code") throw new Error("Provider route is no longer waiting for a verification code.");
				if (run.executionStatus === "sending_code") return { state: "already_started" as const };
				if (!run.skyvernRunId || !["waiting_code", "running"].includes(run.executionStatus)) {
					throw new Error("Provider run is not eligible for verification-code delivery.");
				}
				const timestamp = now();
				const mailCodeId = generateId();
				tx.insert(abuseMailCodes)
					.values({
						id: mailCodeId,
						reportId: route.reportId,
						routeId: route.id,
						runId: run.id,
						mailMessageId: params.mailMessageId,
						codeHash: sha256Hex(params.code),
						correlationKey: params.correlationKey,
						status: "delivery_started",
						createdAt: timestamp,
					})
					.run();
				tx.update(abuseProviderRuns)
					.set({ executionStatus: "sending_code", updatedAt: timestamp })
					.where(eq(abuseProviderRuns.id, run.id))
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.totp_delivery_started",
					data: { mailMessageId: params.mailMessageId.toString() },
				});
				return { state: "prepared" as const, mailCodeId };
			},
			{ behavior: "immediate" },
		);
	}

	/**
	 * Completes a code-delivery attempt only if the same run is still in the
	 * durable pre-side-effect state. A late SDK success after reconciliation has
	 * settled the route is ignored rather than reopening or overwriting it.
	 */
	static async settleTotpDelivery(params: { routeId: bigint; runId: bigint; mailCodeId: bigint }): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
				const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, params.routeId)).get();
				if (!run || !route || run.routeId !== route.id || run.executionStatus !== "sending_code" || route.status !== "waiting_code") return false;
				const code = tx.select().from(abuseMailCodes).where(eq(abuseMailCodes.id, params.mailCodeId)).get();
				if (!code || code.runId !== run.id || code.status !== "delivery_started") return false;
				const timestamp = now();
				const runUpdated = tx
					.update(abuseProviderRuns)
					.set({ executionStatus: "running", updatedAt: timestamp })
					.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "sending_code")))
					.returning({ id: abuseProviderRuns.id })
					.get();
				if (!runUpdated) return false;
				const routeUpdated = tx
					.update(abuseProviderRoutes)
					.set({ status: "running", updatedAt: timestamp })
					.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "waiting_code")))
					.returning({ id: abuseProviderRoutes.id })
					.get();
				if (!routeUpdated) throw new Error("Verification code was delivered after the route left waiting_code.");
				tx.update(abuseMailCodes)
					.set({ status: "used", usedAt: timestamp })
					.where(and(eq(abuseMailCodes.id, code.id), eq(abuseMailCodes.status, "delivery_started")))
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.totp_delivery_completed",
					data: { mailCodeId: code.id.toString() },
				});
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "route.status_changed",
					data: { from: "waiting_code", to: "running", reason: "totp_delivery_completed" },
				});
				recomputeReportStatusInTransaction(tx, route.reportId, { reason: "totp_delivery_completed", routeId: route.id.toString() });
				return true;
			},
			{ behavior: "immediate" },
		);
	}

	static async markMailCodeUsed(codeId: bigint): Promise<void> {
		const db = await getDb();
		await db.update(abuseMailCodes).set({ status: "used", usedAt: now() }).where(eq(abuseMailCodes.id, codeId));
	}

	static async persistWebhook(params: { eventId: string; skyvernRunId?: string; timestamp: number; payload: Record<string, unknown>; payloadHash: string }): Promise<boolean> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const existing = tx.select({ id: abuseWebhookEvents.id }).from(abuseWebhookEvents).where(eq(abuseWebhookEvents.eventId, params.eventId)).get();
				if (existing) return false;
				tx.insert(abuseWebhookEvents)
					.values({
						id: generateId(),
						eventId: params.eventId,
						skyvernRunId: params.skyvernRunId,
						timestamp: params.timestamp,
						payload: params.payload,
						payloadHash: params.payloadHash,
						receivedAt: now(),
					})
					.run();
				return true;
			},
			{ behavior: "immediate" }
		);
	}

	static async enqueueReconciliationForSkyvernRun(skyvernRunId: string): Promise<AbuseJob | undefined> {
		const run = await this.getProviderRunBySkyvernRunId(skyvernRunId);
		if (!run) return undefined;
		return this.enqueueJob({
			jobType: "reconcile_skyvern_run",
			reportId: run.reportId,
			routeId: run.routeId,
			runId: run.id,
			payload: { skyvernRunId },
			dedupeKey: `reconcile:${run.id.toString()}:${skyvernRunId}`,
		});
	}

	static async listEvents(reportId: bigint): Promise<AbuseEvent[]> {
		const db = await getDb();
		return db.select().from(abuseEvents).where(eq(abuseEvents.reportId, reportId)).orderBy(asc(abuseEvents.createdAt)).all();
	}

	static async recomputeReportStatus(reportId: bigint): Promise<AbuseReportStatus> {
		const db = await getDb();
		return db.transaction(
			(tx) => {
				const status = recomputeReportStatusInTransaction(tx, reportId, { reason: "explicit_recompute" });
				if (!status) throw new Error(`Abuse report ${reportId.toString()} does not exist.`);
				return status;
			},
			{ behavior: "immediate" },
		);
	}

	/** The safe, token-authorized public read model. It deliberately omits all primary keys and secrets. */
	static async getPublicStatus(token: string) {
		const report = await this.getReportByTrackingToken(token);
		if (!report) return undefined;
		const [targets, routes, runs] = await Promise.all([this.listTargets(report.id), this.listRoutes(report.id), this.listProviderRunsForReport(report.id)]);
		const latestRunByRoute = new Map<bigint, AbuseProviderRun>();
		for (const run of runs) if (!latestRunByRoute.has(run.routeId)) latestRunByRoute.set(run.routeId, run);
		const routesByTarget = new Map<bigint, Array<Record<string, unknown>>>();
		for (const route of routes) {
			const run = latestRunByRoute.get(route.id);
			const item = {
				provider: route.providerDisplayName,
				routeType: route.routeType === "manual_unroutable" ? "manual/unroutable" : route.routeType,
				status: route.status,
				confirmationId: run?.confirmationId,
				error: safePublicError(route.status, run?.failureReason),
			};
			const list = routesByTarget.get(route.targetId) ?? [];
			list.push(item);
			routesByTarget.set(route.targetId, list);
		}
		return {
			status: report.status,
			createdAt: report.createdAt.toISOString(),
			updatedAt: report.updatedAt.toISOString(),
			targets: targets.map((target) => ({
				target: target.normalizedTarget,
				type: target.targetType,
				status: target.resolutionStatus,
				disposition: safePublicError(target.resolutionStatus, target.disposition),
				providerRoutes: routesByTarget.get(target.id) ?? [],
			})),
		};
	}
}

export function aggregateReportStatus(routeStatuses: AbuseRouteStatus[]): AbuseReportStatus {
	if (routeStatuses.length === 0) return "no_route";
	if (routeStatuses.includes("needs_human")) return "needs_human";
	// An ambiguous provider side effect must be visible at once. A concurrent
	// route can keep working, but it cannot make the aggregate look healthy or
	// hide the fact that an operator must reconcile an external outcome.
	if (routeStatuses.includes("unknown_external_state")) return "failed";
	// Use a lifecycle priority rather than the database/order-dependent first
	// active route. For example, a second target still resolving must not make
	// a report with a first target actively submitting regress from `running`
	// to `resolving` whenever an aggregate is recomputed.
	if (routeStatuses.some((status) => ["running", "waiting_code", "escalating_to_portal"].includes(status))) return "running";
	if (routeStatuses.includes("queued")) return "queued";
	if (routeStatuses.includes("verified")) return "verifying";
	if (routeStatuses.includes("resolving")) return "resolving";
	if (routeStatuses.includes("awaiting_provider_reply")) return "waiting_provider";

	const successful = routeStatuses.filter((status) => status === "submitted" || status === "acknowledged").length;
	if (successful === routeStatuses.length) return "submitted";
	if (successful > 0) return "partially_submitted";

	const routable = routeStatuses.filter((status) => status !== "no_route");
	if (routable.length === 0) return "no_route";
	if (routable.every((status) => status === "insufficient_evidence")) return "insufficient_evidence";

	// `unknown_external_state` is intentionally surfaced as a safe failure at
	// the aggregate layer. It must never be mistaken for a successful route or
	// silently hidden behind an otherwise-completed report.
	return "failed";
}
