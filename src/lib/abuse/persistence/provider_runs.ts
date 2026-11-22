import crypto from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db";
import { isFabricBrowserSessionId } from "../../browser/fabric_session";
import {
	abuseJobs,
	abuseProviderRoutes,
	abuseProviderRuns,
	type AbuseProviderRun,
	type AbuseRouteStatus,
	type AbuseRunStatus,
} from "../schema";
import { recomputeReportStatusInTransaction } from "./report_status";
import { insertProviderRun, now, recordEvent } from "./shared";
import { FINAL_OR_BLOCKED_ROUTE_STATUSES } from "./state";
import { hashStableJson } from "../../util/hash";

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
			return { ...insertProviderRun(tx, route, { providerPayload: params.providerPayload, correlationKey, executionStatus: params.executionStatus ?? "pending" }), created: true };
		},
		{ behavior: "immediate" }
	);
}

export async function getProviderRun(runId: bigint): Promise<AbuseProviderRun | undefined> {
	const db = await getDb();
	return db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, runId)).get();
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
				inArray(abuseProviderRuns.executionStatus, ["pending", "starting", "task_started", "submission_started", "running", "unknown_external_state"]),
			),
		)
		.orderBy(desc(abuseProviderRuns.createdAt))
		.limit(1)
		.get();
}

/**
 * Replace the draft of a run that has not reached its marker. Returns false
 * when the run left `starting`, so a draft is never rewritten under a marker.
 */
export async function replaceStartingDraft(runId: bigint, payload: Record<string, unknown>): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx
				.update(abuseProviderRuns)
				.set({ providerPayload: payload, payloadHash: hashStableJson(payload), updatedAt: now() })
				.where(and(eq(abuseProviderRuns.id, runId), eq(abuseProviderRuns.executionStatus, "starting")))
				.returning()
				.get();
			if (!run) return false;
			recordEvent(tx, { reportId: run.reportId, routeId: run.routeId, runId, eventType: "provider_run.draft_refreshed", data: { payloadHash: run.payloadHash } });
			return true;
		},
		{ behavior: "immediate" }
	);
}

/**
 * Atomically finish a direct-provider job whose local preflight exhausted all
 * retries before the irreversible submission marker was acquired.
 */
export async function failProviderSubmissionPreflight(params: {
	jobId: bigint;
	owner: string;
	error: string;
}): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const job = tx.select().from(abuseJobs).where(eq(abuseJobs.id, params.jobId)).get();
			if (!job
				|| job.jobType !== "submit_provider"
				|| job.status !== "running"
				|| job.leaseOwner !== params.owner
				|| !job.routeId) return false;

			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, job.routeId)).get();
			if (!route || route.routeType !== "provider_submission" || route.status !== "running") return false;

			const run = job.runId
				? tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, job.runId)).get()
				: tx.select()
					.from(abuseProviderRuns)
					.where(and(eq(abuseProviderRuns.routeId, route.id), eq(abuseProviderRuns.executionStatus, "starting")))
					.orderBy(desc(abuseProviderRuns.createdAt), desc(abuseProviderRuns.id))
					.limit(1)
					.get();
			if (!run || run.routeId !== route.id || run.executionStatus !== "starting") return false;

			const timestamp = now();
			tx.update(abuseJobs)
				.set({
					status: "failed",
					leaseOwner: null,
					leaseExpiresAt: null,
					lastError: params.error,
					updatedAt: timestamp,
				})
				.where(eq(abuseJobs.id, job.id))
				.run();
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				jobId: job.id,
				eventType: "job.failed",
				data: { error: params.error, retryCount: job.retryCount },
			});

			tx.update(abuseProviderRuns)
				.set({ executionStatus: "failed", failureReason: params.error, updatedAt: timestamp })
				.where(eq(abuseProviderRuns.id, run.id))
				.run();
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				jobId: job.id,
				eventType: "provider_run.settled",
				data: { executionStatus: "failed", failureReason: params.error },
			});

			tx.update(abuseProviderRoutes)
				.set({ status: "failed", updatedAt: timestamp })
				.where(eq(abuseProviderRoutes.id, route.id))
				.run();
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				jobId: job.id,
				eventType: "route.status_changed",
				data: { from: route.status, to: "failed", reason: "retry_exhausted", error: params.error },
			});

			recomputeReportStatusInTransaction(tx, route.reportId, {
				reason: "provider_preflight_retry_exhausted",
				routeId: route.id.toString(),
			});
			return true;
		},
		{ behavior: "immediate" },
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
 * Settle a direct-provider run after a read-only external reconciliation.
 *
 * Normal settlement intentionally refuses `unknown_external_state` because a
 * late callback must never overwrite an unresolved side effect. Reconciliation
 * is a separate, explicit compare-and-set path: the caller must first verify a
 * provider receipt (and, where possible, its submitted target) without making
 * another provider submission. This lets an operator repair a parser/schema
 * drift incident without weakening the no-replay boundary.
 */
/**
 * Settle an unresolved run from verified external evidence. `submitted`
 * needs the provider's receipt; `provider_rejected` needs proof that the
 * request never reached the provider (for example its firewall answering
 * in its place). Only the route's latest run may be settled, and only from
 * `unknown_external_state`; unresolved submit jobs for the route are closed.
 */
async function settleUnresolvedProviderRun(params: {
	runId: bigint;
	providerRegistryKey: string;
	reason: string;
	outcome:
		| { routeStatus: "submitted"; confirmationId: string; confirmationText?: string; finalUrl?: string; submittedTargets: string[] }
		| { routeStatus: "provider_rejected"; failureReason: string };
}): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
			if (!run) return false;
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
			if (!route || route.providerRegistryKey !== params.providerRegistryKey) return false;
			if (route.status !== "unknown_external_state" || run.executionStatus !== "unknown_external_state") return false;
			// A route can only be repaired from its current unresolved run. If an
			// older run somehow remains alongside a newer attempt, accepting the
			// older evidence could settle the route for the wrong provider request.
			const latestRun = tx
				.select({ id: abuseProviderRuns.id })
				.from(abuseProviderRuns)
				.where(eq(abuseProviderRuns.routeId, route.id))
				.orderBy(desc(abuseProviderRuns.createdAt), desc(abuseProviderRuns.id))
				.limit(1)
				.get();
			if (!latestRun || latestRun.id !== run.id) return false;

			const timestamp = now();
			const { outcome } = params;
			tx.update(abuseProviderRuns)
				.set(outcome.routeStatus === "submitted"
					? {
						executionStatus: "completed",
						confirmationId: outcome.confirmationId,
						confirmationText: outcome.confirmationText,
						finalUrl: outcome.finalUrl,
						submittedTargets: [...outcome.submittedTargets],
						failureReason: null,
						updatedAt: timestamp,
					}
					: { executionStatus: "failed", failureReason: outcome.failureReason, updatedAt: timestamp })
				.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "unknown_external_state")))
				.run();
			recordEvent(tx, {
				reportId: run.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				eventType: "provider_run.reconciled",
				data: {
					providerRegistryKey: params.providerRegistryKey,
					to: outcome.routeStatus,
					...(outcome.routeStatus === "submitted" ? { confirmationId: outcome.confirmationId } : { failureReason: outcome.failureReason }),
					reconciliationReason: params.reason,
				},
			});

			// The original `submit_provider` job has no run ID because the run is
			// created while the job is executing. Close only unresolved jobs for
			// this exact route; a later/manual job must not be rewritten.
			const unresolvedJobs = tx
				.select()
				.from(abuseJobs)
				.where(and(
					eq(abuseJobs.routeId, route.id),
					eq(abuseJobs.jobType, "submit_provider"),
					eq(abuseJobs.status, "unknown_external_state"),
				))
				.all();
			for (const job of unresolvedJobs) {
				tx.update(abuseJobs)
					.set({
						status: "completed",
						leaseOwner: null,
						leaseExpiresAt: null,
						unknownExternalState: false,
						lastError: null,
						updatedAt: timestamp,
					})
					.where(and(eq(abuseJobs.id, job.id), eq(abuseJobs.status, "unknown_external_state")))
					.run();
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					jobId: job.id,
					eventType: "job.reconciled",
					data: { from: "unknown_external_state", to: "completed", reason: params.reason },
				});
			}

			const routeUpdated = tx
				.update(abuseProviderRoutes)
				.set({ status: outcome.routeStatus, updatedAt: timestamp })
				.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "unknown_external_state")))
				.returning({ id: abuseProviderRoutes.id })
				.get();
			if (!routeUpdated) throw new Error("Provider reconciliation could not update the unresolved route.");
			recordEvent(tx, {
				reportId: route.reportId,
				targetId: route.targetId,
				routeId: route.id,
				runId: run.id,
				eventType: "route.status_changed",
				data: { from: route.status, to: outcome.routeStatus, reason: params.reason },
			});
			recomputeReportStatusInTransaction(tx, route.reportId, {
				reason: "provider_run_reconciled",
				routeId: route.id.toString(),
			});
			return true;
		},
		{ behavior: "immediate" },
	);
}

/** Settle an unresolved run as submitted from the provider's verified receipt. */
export async function reconcileProviderRun(params: {
	runId: bigint;
	providerRegistryKey: string;
	confirmationId: string;
	confirmationText?: string;
	finalUrl?: string;
	submittedTargets: string[];
	reconciliationReason?: string;
}): Promise<boolean> {
	if (!params.confirmationId.trim()) throw new Error("A reconciled provider run requires a confirmation identifier.");
	if (params.submittedTargets.length === 0 || params.submittedTargets.some((target) => !target.trim())) {
		throw new Error("A reconciled provider run requires at least one submitted target.");
	}
	return settleUnresolvedProviderRun({
		runId: params.runId,
		providerRegistryKey: params.providerRegistryKey,
		reason: params.reconciliationReason ?? "verified_external_receipt",
		outcome: {
			routeStatus: "submitted",
			confirmationId: params.confirmationId,
			...(params.confirmationText ? { confirmationText: params.confirmationText } : {}),
			...(params.finalUrl ? { finalUrl: params.finalUrl } : {}),
			submittedTargets: params.submittedTargets,
		},
	});
}

/** Settle an unresolved run as rejected once it is proven the request never reached the provider. */
export async function reconcileProviderRunRejection(params: {
	runId: bigint;
	providerRegistryKey: string;
	failureReason: string;
	reconciliationReason: string;
}): Promise<boolean> {
	if (!params.failureReason.trim()) throw new Error("A rejected reconciliation requires its failure reason.");
	return settleUnresolvedProviderRun({
		runId: params.runId,
		providerRegistryKey: params.providerRegistryKey,
		reason: params.reconciliationReason,
		outcome: { routeStatus: "provider_rejected", failureReason: params.failureReason },
	});
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
 * The durable boundary of a provider-form browser task: the run moves from
 * `starting` to `task_started` and keeps the Fabric session that runs it,
 * before the agent touches the provider's page. A restart that finds a run
 * in `task_started` cannot know whether the form was submitted; it fails
 * closed (unknown external state) and cancels that browser instead of
 * running the task again.
 */
export async function startBrowserTask(params: { runId: bigint; fabricSessionId: string }): Promise<boolean> {
	if (!isFabricBrowserSessionId(params.fabricSessionId)) throw new Error("Browser Fabric returned an invalid session ID.");
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const run = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, params.runId)).get();
			if (!run || run.executionStatus !== "starting") return false;
			const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, run.routeId)).get();
			if (!route || route.status !== "running") return false;
			const providerPayload = { ...run.providerPayload, __fabricBrowserSessionId: params.fabricSessionId };
			const updated = tx
				.update(abuseProviderRuns)
				.set({
					executionStatus: "task_started",
					providerPayload,
					payloadHash: hashStableJson(providerPayload),
					attemptCount: run.attemptCount + 1,
					updatedAt: now(),
				})
				.where(and(eq(abuseProviderRuns.id, run.id), eq(abuseProviderRuns.executionStatus, "starting")))
				.returning({ id: abuseProviderRuns.id })
				.get();
			if (!updated) return false;
			recordEvent(tx, {
				reportId: run.reportId,
				routeId: route.id,
				runId: run.id,
				eventType: "provider_run.browser_task_started",
				data: { fabricSessionId: params.fabricSessionId },
			});
			return true;
		},
		{ behavior: "immediate" },
	);
}

/**
 * Return routes stranded in `unknown_external_state` to `queued` when their
 * run's own failure proves no request left: the failure reason must equal
 * `neverSentFailure` exactly, a failure the provider can only raise before it
 * opens its page. The run goes back to `starting` (the executor resumes it
 * before its marker, with the same draft) and the route's unresolved
 * `submit_provider` job is queued again. Any route that does not match
 * exactly, or whose run is not its latest, is left untouched.
 */
export async function requeueNeverSentProviderRuns(params: {
	providerRegistryKey: string;
	neverSentFailure: string;
	reason: string;
}): Promise<bigint[]> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const requeued: bigint[] = [];
			const routes = tx.select().from(abuseProviderRoutes)
				.where(and(eq(abuseProviderRoutes.providerRegistryKey, params.providerRegistryKey), eq(abuseProviderRoutes.status, "unknown_external_state")))
				.all();
			for (const route of routes) {
				const run = tx.select().from(abuseProviderRuns)
					.where(eq(abuseProviderRuns.routeId, route.id))
					.orderBy(desc(abuseProviderRuns.createdAt), desc(abuseProviderRuns.id))
					.limit(1)
					.get();
				if (!run || run.executionStatus !== "unknown_external_state" || run.failureReason !== params.neverSentFailure) continue;
				const timestamp = now();
				tx.update(abuseProviderRuns)
					.set({ executionStatus: "starting", failureReason: null, updatedAt: timestamp })
					.where(eq(abuseProviderRuns.id, run.id))
					.run();
				tx.update(abuseProviderRoutes)
					.set({ status: "queued", updatedAt: timestamp })
					.where(eq(abuseProviderRoutes.id, route.id))
					.run();
				const jobs = tx.select({ id: abuseJobs.id }).from(abuseJobs)
					.where(and(eq(abuseJobs.routeId, route.id), eq(abuseJobs.jobType, "submit_provider"), eq(abuseJobs.status, "unknown_external_state")))
					.all();
				for (const job of jobs) {
					tx.update(abuseJobs)
						.set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, unknownExternalState: false, lastError: null, nextAttemptAt: timestamp, updatedAt: timestamp })
						.where(eq(abuseJobs.id, job.id))
						.run();
				}
				recordEvent(tx, {
					reportId: route.reportId,
					targetId: route.targetId,
					routeId: route.id,
					runId: run.id,
					eventType: "provider_run.requeued_never_sent",
					data: { providerRegistryKey: params.providerRegistryKey, failureReason: params.neverSentFailure, jobIds: jobs.map((job) => job.id.toString()), reason: params.reason },
				});
				recomputeReportStatusInTransaction(tx, route.reportId, { reason: "provider_run_requeued_never_sent", routeId: route.id.toString() });
				requeued.push(route.id);
			}
			return requeued;
		},
		{ behavior: "immediate" },
	);
}
