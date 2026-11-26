import { and, asc, eq, gt, inArray, like, lte, ne, notLike, or, sql } from "drizzle-orm";

import { getDb, type DbExecutor } from "../../db";
import { generateId } from "../../db/ids";
import {
	abuseJobs,
	type AbuseJob,
	type AbuseJobStatus,
	type AbuseJobType,
} from "../schema";
import { now, recordEvent } from "./shared";

type NewJob = {
	jobType: AbuseJobType;
	reportId: bigint;
	routeId?: bigint;
	runId?: bigint;
	payload?: Record<string, unknown>;
	dedupeKey?: string;
	nextAttemptAt?: Date;
};

/** Insert a queued job and its `job.queued` event inside the caller's transaction. */
export function insertQueuedJob(tx: DbExecutor, params: NewJob, eventData: Record<string, unknown> = {}): AbuseJob {
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
	recordEvent(tx, { reportId: params.reportId, routeId: params.routeId, runId: params.runId, jobId: id, eventType: "job.queued", data: { jobType: params.jobType, ...eventData } });
	return tx.select().from(abuseJobs).where(eq(abuseJobs.id, id)).get()!;
}

export async function enqueueJob(params: NewJob & {
	/** The running job that queues its own successor; it does not count as a duplicate. */
	successorOf?: bigint;
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
							...(params.successorOf === undefined ? [] : [ne(abuseJobs.id, params.successorOf)]),
						),
					)
					.get();
				if (existing) return existing;
			}
			const { successorOf: _successorOf, ...job } = params;
			return insertQueuedJob(tx, job);
		},
		{ behavior: "immediate" }
	);
}

/**
 * Drop the jobs still waiting under a dedupe-key prefix, except those under
 * `keep`: work a newer batch makes pointless (an older sweep's relinks once
 * the rules changed again). Running and finished jobs stay on record.
 */
export async function discardQueuedJobs(prefix: string, keep: string): Promise<number> {
	const db = await getDb();
	return db.delete(abuseJobs)
		.where(and(eq(abuseJobs.status, "queued"), like(abuseJobs.dedupeKey, `${prefix}%`), notLike(abuseJobs.dedupeKey, `${keep}%`)))
		.returning({ id: abuseJobs.id })
		.all().length;
}

/** The address of every kit-sibling analysis a kit file's search queued, in any state. */
export async function listKitSiblingAnalysisUrls(sha256: string): Promise<string[]> {
	const db = await getDb();
	return db.select({ url: sql<string>`json_extract(${abuseJobs.payload}, '$.url')` })
		.from(abuseJobs)
		.where(and(eq(abuseJobs.jobType, "analyze_kit_sibling"), sql`exists (select 1 from json_each(${abuseJobs.payload}, '$.hashes') where value = ${sha256})`))
		.all()
		.map(({ url }) => url);
}

/** Whether any job, in any state, was ever queued under this dedupe key. */
export async function hasJob(dedupeKey: string): Promise<boolean> {
	const db = await getDb();
	return Boolean(db.select({ id: abuseJobs.id }).from(abuseJobs).where(eq(abuseJobs.dedupeKey, dedupeKey)).get());
}

/** The report's jobs still waiting to run, soonest first: what the case page says happens next. */
export async function listQueuedJobsForReport(reportId: bigint): Promise<Array<Pick<AbuseJob, "jobType" | "routeId" | "nextAttemptAt">>> {
	const db = await getDb();
	return db
		.select({ jobType: abuseJobs.jobType, routeId: abuseJobs.routeId, nextAttemptAt: abuseJobs.nextAttemptAt })
		.from(abuseJobs)
		.where(and(eq(abuseJobs.reportId, reportId), eq(abuseJobs.status, "queued")))
		.orderBy(asc(abuseJobs.nextAttemptAt))
		.all();
}

/**
 * Enqueue a lifecycle job exactly once, including across completed and failed
 * executions. This is for immutable source events such as a provider message;
 * recurring jobs must continue to use `enqueueJob`'s active-only dedupe.
 */
export async function enqueueJobOnce(params: NewJob & { dedupeKey: string }): Promise<AbuseJob> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const existing = tx.select().from(abuseJobs).where(eq(abuseJobs.dedupeKey, params.dedupeKey)).get();
			return existing ?? insertQueuedJob(tx, params, { lifetimeDedupe: true });
		},
		{ behavior: "immediate" },
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

type RequeueParams = { jobId: bigint; owner: string; error: string; afterMs: number };

/** Queue a failed job again; its failure spends one of its attempts. */
export async function retryJob(params: RequeueParams): Promise<void> {
	await requeueJob(params, "job.retried", 1);
}

/**
 * Queue a job again that could not run because something it needs was not
 * there yet (no browser): it did no work, so it spends none of its attempts.
 */
export async function deferJob(params: RequeueParams): Promise<void> {
	await requeueJob(params, "job.deferred", 0);
}

async function requeueJob(params: RequeueParams, eventType: "job.retried" | "job.deferred", attempts: 0 | 1): Promise<void> {
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
					retryCount: job.retryCount + attempts,
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
				eventType,
				data: { retryCount: job.retryCount + attempts, error: params.error },
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
