import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import {
	abuseJobs,
	type AbuseJob,
	type AbuseJobStatus,
	type AbuseJobType,
} from "../schema";
import { now, recordEvent } from "./shared";

export async function enqueueJob(params: {
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

export type JobClaimFilter = {
	/** Restrict a lane to a concrete set of job types. */
	readonly jobTypes?: readonly AbuseJobType[];
};

export async function claimNextJob(owner: string, leaseMs: number, filter: JobClaimFilter = {}): Promise<AbuseJob | undefined> {
	const db = await getDb();
	const timestamp = now();
	const leaseExpiresAt = new Date(timestamp.getTime() + leaseMs);
	return db.transaction(
		(tx) => {
			const typeFilter = filter.jobTypes?.length ? inArray(abuseJobs.jobType, [...filter.jobTypes]) : undefined;
			const candidates = tx
				.select()
				.from(abuseJobs)
				.where(
						and(
							or(
								and(eq(abuseJobs.status, "queued"), lte(abuseJobs.nextAttemptAt, timestamp)),
								and(eq(abuseJobs.status, "running"), lte(abuseJobs.leaseExpiresAt, timestamp), eq(abuseJobs.unknownExternalState, false)),
							),
							typeFilter,
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

export async function renewJobLease(jobId: bigint, owner: string, leaseMs: number): Promise<boolean> {
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

export async function completeJob(jobId: bigint, owner: string): Promise<void> {
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

export async function retryJob(params: { jobId: bigint; owner: string; error: string; afterMs: number }): Promise<void> {
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

export async function markJobUnknownExternalState(params: { jobId: bigint; owner: string; error: string }): Promise<void> {
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

export async function failJob(params: { jobId: bigint; owner: string; error: string }): Promise<void> {
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

export async function recoverStaleJobs(): Promise<number> {
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
