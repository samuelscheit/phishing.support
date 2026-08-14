import crypto from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import {
	abuseJobs,
	abuseProviderRoutes,
	abuseProviderRuns,
	type AbuseProviderRun,
	type AbuseRouteStatus,
	type AbuseRunStatus,
} from "../schema";
import { hashStableJson } from "../security";
import { recomputeReportStatusInTransaction } from "./report_status";
import { now, recordEvent } from "./shared";
import { FINAL_OR_BLOCKED_ROUTE_STATUSES } from "./state";

export async function createProviderRun(params: {
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

export async function getProviderRun(runId: bigint): Promise<AbuseProviderRun | undefined> {
	const db = await getDb();
	return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, runId)).get();
}

export async function getProviderRunBySkyvernRunId(skyvernRunId: string): Promise<AbuseProviderRun | undefined> {
	const db = await getDb();
	return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.skyvernRunId, skyvernRunId)).get();
}

export async function getProviderRunByCorrelationKey(correlationKey: string): Promise<AbuseProviderRun | undefined> {
	const db = await getDb();
	return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, correlationKey)).get();
}

export async function listProviderRunsForReport(reportId: bigint) {
	const db = await getDb();
	return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.reportId, reportId)).orderBy(desc(abuseProviderRuns.createdAt)).all();
}

export async function getLatestProviderRunForRoute(routeId: bigint): Promise<AbuseProviderRun | undefined> {
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

export async function getLatestActiveProviderRunForRoute(routeId: bigint): Promise<AbuseProviderRun | undefined> {
	const db = await getDb();
	return db
		.select()
		.from(abuseProviderRuns)
		.where(
			and(
				eq(abuseProviderRuns.routeId, routeId),
				inArray(abuseProviderRuns.executionStatus, ["pending", "starting", "task_creation_started", "submission_started", "running", "unknown_external_state"]),
			),
		)
		.orderBy(desc(abuseProviderRuns.createdAt))
		.limit(1)
		.get();
}

export async function updateProviderRun(runId: bigint, values: Partial<typeof abuseProviderRuns.$inferInsert>, eventType = "provider_run.updated"): Promise<void> {
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
 * Finish a known provider run and its provider route in one transaction.
 * Repeated callbacks and stale reconciliation jobs cannot downgrade an
 * already-settled route when an external provider later omits old output or
 * artifacts.
 */

export async function settleProviderRun(params: {
	runId: bigint;
	executionStatus: "completed" | "failed" | "canceled";
	routeStatus: "submitted" | "provider_rejected" | "insufficient_evidence" | "needs_human" | "failed";
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
				reason: "provider_run_settled",
				routeId: route.id.toString(),
			});
			return true;
		},
		{ behavior: "immediate" },
	);
}

/**
 * Persist the durable pre-call marker for a direct provider submission. The
 * immutable provider payload is already stored on the run; once this marker
 * succeeds, a restart must treat a missing provider response as ambiguous
 * rather than retrying the submission and risking a duplicate complaint.
 */

export async function prepareProviderSubmission(runId: bigint): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, runId)).get();
			if (!run || run.executionStatus !== "starting") return false;
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
			if (!route || route.routeType !== "provider_submission" || route.status !== "running") return false;
			const timestamp = now();
			const updated = tx
				.update(abuseProviderRuns)
				.set({ executionStatus: "submission_started", updatedAt: timestamp })
				.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting")))
				.returning({ id: abuseProviderRuns.id })
				.get();
			if (!updated) return false;
			recordEvent(tx, {
				reportId: run.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				eventType: "provider_run.provider_submission_started",
				data: { from: "starting", to: "submission_started" },
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

export async function prepareSkyvernTaskCreation(runId: bigint): Promise<boolean> {
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

export type SkyvernTaskStartedTransition = {
	executionStatus: AbuseRunStatus;
	routeStatus: AbuseRouteStatus;
};

/**
 * Apply the shared, atomic Skyvern response boundary with a provider-owned
 * lifecycle transition. The generic worker uses the public wrapper below,
 * which always settles a run and route into `running`; providers with an
 * additional durable phase supply that phase from their own persistence
 * module without putting its vocabulary in this generic core.
 */
export async function recordSkyvernTaskStartedWithTransition(params: {
	runId: bigint;
	skyvernRunId: string;
	expectedProviderKey?: string;
	transition: SkyvernTaskStartedTransition;
}): Promise<boolean> {
	if (!/^[A-Za-z0-9._:-]{1,256}$/.test(params.skyvernRunId)) throw new Error("Skyvern returned an invalid run ID.");
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
			if (!run || run.executionStatus !== "task_creation_started") return false;
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
			if (!route || route.status !== "running" || (params.expectedProviderKey && route.providerRegistryKey !== params.expectedProviderKey)) return false;
			const timestamp = now();
			const runUpdated = tx
				.update(abuseProviderRuns)
				.set({
					skyvernRunId: params.skyvernRunId,
					executionStatus: params.transition.executionStatus,
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
				data: { skyvernRunId: params.skyvernRunId, executionStatus: params.transition.executionStatus },
			});
			if (params.transition.routeStatus !== route.status) {
				const routeUpdated = tx
					.update(abuseProviderRoutes)
					.set({ status: params.transition.routeStatus, updatedAt: timestamp })
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
					data: { from: route.status, to: params.transition.routeStatus, reason: "skyvern_task_started" },
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

/** Persist a generic Skyvern task response without assuming provider phases. */
export async function recordSkyvernTaskStarted(params: { runId: bigint; skyvernRunId: string }): Promise<boolean> {
	return recordSkyvernTaskStartedWithTransition({
		...params,
		transition: { executionStatus: "running", routeStatus: "running" },
	});
}

/**
 * Settle a known SMTP outcome and its route in one compare-and-set
 * transaction. This prevents a late bounce, a duplicate classifier, or a
 * lease-replayed sender from overwriting a newer email lifecycle state.
 */
