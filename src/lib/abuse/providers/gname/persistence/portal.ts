import { and, eq, sql } from "drizzle-orm";

import { getDb } from "../../../../db";
import { generateId } from "../../../../db/ids";
import { abuseProviderRoutes, abuseProviderRuns, type AbuseProviderRun } from "../../../schema";
import { hashStableJson, stableJson } from "../../../security";
import { recomputeReportStatusInTransaction } from "../../../persistence/report_status";
import { now, recordEvent } from "../../../persistence/shared";
import { acquireMailboxLeaseInTransaction } from "./mailbox";

export async function beginGnamePortalExecution(params: {
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
			if (!route || route.providerRegistryKey !== "gname" || !["queued", "running"].includes(route.status)) {
				return { acquired: false, reason: "route_not_eligible" as const };
			}

			const existingRun = tx.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.correlationKey, params.correlationKey)).get();
			if (existingRun && (existingRun.routeId !== route.id || existingRun.reportId !== route.reportId)) {
				throw new Error("GNAME portal correlation key belongs to a different route.");
			}
			if (route.status === "running" && !existingRun) return { acquired: false, reason: "missing_run" as const };

			const mailboxLease = acquireMailboxLeaseInTransaction(tx, {
				routeId: route.id,
				lockKey: params.lockKey,
				owner: params.lockOwner,
				leaseMs: params.lockLeaseMs,
			});
			if (!mailboxLease.acquired) {
				return { acquired: false, reason: mailboxLease.reason === "route_missing" ? "route_not_eligible" : mailboxLease.reason };
			}
			const timestamp = now();

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

export async function prepareGnamePortalTaskPayload(params: { runId: bigint; providerPayload: Record<string, unknown> }): Promise<boolean> {
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

export async function beginGnameEvidenceUpload(params: {
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

export async function recordGnameEvidenceUpload(params: {
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

export async function requeueGnamePortalPreparation(params: { runId: bigint; error: string }): Promise<boolean> {
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
