import { and, asc, desc, eq, inArray, like, lte, ne, notLike, or, sql, type SQL } from "drizzle-orm";

import { getDb, type DbExecutor } from "../../db";
import { generateId } from "../../db/ids";
import {
	jobs,
	type Job,
	type JobStatus,
	type JobType,
} from "../schema";
import { now, recordEvent } from "./shared";

export type NewJob = {
	jobType: JobType;
	/** The report the job works for; a website visit belongs to a case, not a report. */
	reportId?: bigint;
	routeId?: bigint;
	runId?: bigint;
	payload?: Record<string, unknown>;
	dedupeKey?: string;
	/** The share it counts against in a fair-share lane. */
	fairKey?: string;
	/** At most one job per key runs at once; a route's jobs default to `route:<id>`. */
	serialKey?: string;
	nextAttemptAt?: Date;
};

/** The serial key of a job: its own, else its provider route's, so a route never runs two jobs at once. */
function serialKeyOf(params: Pick<NewJob, "serialKey" | "routeId">): string | undefined {
	return params.serialKey ?? (params.routeId === undefined ? undefined : `route:${params.routeId.toString()}`);
}

/**
 * A job's lifecycle event on its report's audit trail. A job without a report
 * (a website visit) has no trail there: its case records its runs and retries.
 */
function recordJobEvent(
	tx: DbExecutor,
	job: { id: bigint; reportId?: bigint | null; routeId?: bigint | null; runId?: bigint | null },
	eventType: string,
	data?: Record<string, unknown>,
): void {
	if (job.reportId === undefined || job.reportId === null) return;
	recordEvent(tx, { reportId: job.reportId, routeId: job.routeId ?? undefined, runId: job.runId ?? undefined, jobId: job.id, eventType, ...(data ? { data } : {}) });
}

/** Insert a queued job and its `job.queued` event inside the caller's transaction. */
export function insertQueuedJob(tx: DbExecutor, params: NewJob, eventData: Record<string, unknown> = {}): Job {
	const id = generateId();
	const timestamp = now();
	tx.insert(jobs)
		.values({
			id,
			jobType: params.jobType,
			reportId: params.reportId,
			routeId: params.routeId,
			runId: params.runId,
			payload: params.payload ?? {},
			dedupeKey: params.dedupeKey,
			fairKey: params.fairKey,
			serialKey: serialKeyOf(params),
			status: "queued",
			retryCount: 0,
			nextAttemptAt: params.nextAttemptAt ?? timestamp,
			unknownExternalState: false,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	recordJobEvent(tx, { id, ...params }, "job.queued", { jobType: params.jobType, ...eventData });
	return tx.select().from(jobs).where(eq(jobs.id, id)).get()!;
}

/** The job under a dedupe key that is still queued or running (or awaits reconciliation). */
export function activeJobByDedupeKey(tx: DbExecutor, dedupeKey: string, except?: bigint): Job | undefined {
	return tx
		.select()
		.from(jobs)
		.where(
			and(
				eq(jobs.dedupeKey, dedupeKey),
				inArray(jobs.status, ["queued", "running", "unknown_external_state"]),
				...(except === undefined ? [] : [ne(jobs.id, except)]),
			),
		)
		.get();
}

export async function enqueueJob(params: NewJob & {
	/** The running job that queues its own successor; it does not count as a duplicate. */
	successorOf?: bigint;
	/** A queued duplicate due later than `nextAttemptAt` is brought forward to it, instead of left as it is. */
	advance?: boolean;
}): Promise<Job> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const { successorOf, advance, ...job } = params;
			if (job.dedupeKey) {
				const existing = activeJobByDedupeKey(tx, job.dedupeKey, successorOf);
				if (existing && advance && job.nextAttemptAt && existing.status === "queued" && existing.nextAttemptAt > job.nextAttemptAt) {
					tx.update(jobs).set({ nextAttemptAt: job.nextAttemptAt, updatedAt: now() }).where(eq(jobs.id, existing.id)).run();
					return { ...existing, nextAttemptAt: job.nextAttemptAt };
				}
				if (existing) return existing;
			}
			return insertQueuedJob(tx, job);
		},
		{ behavior: "immediate" }
	);
}

/**
 * Queue a job under its dedupe key, replacing the one still waiting there
 * (its payload, keys and due time become these): the newest request for the
 * same work wins. A running job under the key is no duplicate; it may be the
 * one that queues its successor.
 */
export async function replaceQueuedJob(params: NewJob & { dedupeKey: string }): Promise<Job> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const waiting = tx.select().from(jobs).where(and(eq(jobs.dedupeKey, params.dedupeKey), eq(jobs.status, "queued"))).get();
			if (!waiting) return insertQueuedJob(tx, params);
			const changes = {
				payload: params.payload ?? {},
				fairKey: params.fairKey ?? null,
				serialKey: serialKeyOf(params) ?? null,
				nextAttemptAt: params.nextAttemptAt ?? now(),
				retryCount: 0,
				updatedAt: now(),
			};
			tx.update(jobs).set(changes).where(eq(jobs.id, waiting.id)).run();
			return { ...waiting, ...changes };
		},
		{ behavior: "immediate" },
	);
}

/** The newest job ever queued under a dedupe key, in any state. */
export async function latestJobByDedupeKey(dedupeKey: string): Promise<Job | undefined> {
	const db = await getDb();
	return db.select().from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1).get();
}

/** Delete the job still waiting under a dedupe key: work that is no longer wanted. */
export async function discardQueuedJob(dedupeKey: string): Promise<boolean> {
	const db = await getDb();
	return db.delete(jobs).where(and(eq(jobs.dedupeKey, dedupeKey), eq(jobs.status, "queued"))).returning({ id: jobs.id }).all().length > 0;
}

/**
 * Drop the jobs still waiting under a dedupe-key prefix, except those under
 * `keep`: work a newer batch makes pointless (an older sweep's relinks once
 * the rules changed again). Running and finished jobs stay on record.
 */
export async function discardQueuedJobs(prefix: string, keep: string): Promise<number> {
	const db = await getDb();
	return db.delete(jobs)
		.where(and(eq(jobs.status, "queued"), like(jobs.dedupeKey, `${prefix}%`), notLike(jobs.dedupeKey, `${keep}%`)))
		.returning({ id: jobs.id })
		.all().length;
}

/** The address of every kit-sibling analysis a kit file's search queued, in any state. */
export async function listKitSiblingAnalysisUrls(sha256: string): Promise<string[]> {
	const db = await getDb();
	return db.select({ url: sql<string>`json_extract(${jobs.payload}, '$.url')` })
		.from(jobs)
		.where(and(eq(jobs.jobType, "analyze_kit_sibling"), sql`exists (select 1 from json_each(${jobs.payload}, '$.hashes') where value = ${sha256})`))
		.all()
		.map(({ url }) => url);
}

/** Whether any job, in any state, was ever queued under this dedupe key. */
export async function hasJob(dedupeKey: string): Promise<boolean> {
	const db = await getDb();
	return Boolean(db.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).get());
}

/** The report's jobs still waiting to run, soonest first: what the case page says happens next. */
export async function listQueuedJobsForReport(reportId: bigint): Promise<Array<Pick<Job, "jobType" | "routeId" | "dedupeKey" | "nextAttemptAt">>> {
	const db = await getDb();
	return db
		.select({ jobType: jobs.jobType, routeId: jobs.routeId, dedupeKey: jobs.dedupeKey, nextAttemptAt: jobs.nextAttemptAt })
		.from(jobs)
		.where(and(eq(jobs.reportId, reportId), eq(jobs.status, "queued")))
		.orderBy(asc(jobs.nextAttemptAt))
		.all();
}

/** The reports a job of this type waits to run for, each once. */
export async function listReportsWithQueuedJob(jobType: JobType): Promise<bigint[]> {
	const db = await getDb();
	return db
		.selectDistinct({ reportId: jobs.reportId })
		.from(jobs)
		.where(and(eq(jobs.jobType, jobType), eq(jobs.status, "queued")))
		.all()
		.flatMap(({ reportId }) => (reportId === null ? [] : [reportId]));
}

/**
 * Enqueue a lifecycle job exactly once, including across completed and failed
 * executions. This is for immutable source events such as a provider message;
 * recurring jobs must continue to use `enqueueJob`'s active-only dedupe.
 */
export async function enqueueJobOnce(params: NewJob & { dedupeKey: string }): Promise<Job> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const existing = tx.select().from(jobs).where(eq(jobs.dedupeKey, params.dedupeKey)).get();
			return existing ?? insertQueuedJob(tx, params, { lifetimeDedupe: true });
		},
		{ behavior: "immediate" },
	);
}

export type JobClaimFilter = {
	/** Restrict a lane to a concrete set of job types. */
	readonly jobTypes?: readonly JobType[];
	/**
	 * Share the lane between fair keys: a key never holds more than
	 * `perKeyLimit` running jobs, and of the due jobs the one whose key runs
	 * the fewest goes first, oldest first among equals. One reporter's flood
	 * then waits behind everyone else's next job instead of in front of it.
	 */
	readonly fairShare?: { readonly perKeyLimit: number };
};

/** Running with a live lease: a job that holds its serial key and counts against its fair key. */
function liveRunning(alias: string, at: number): SQL {
	return sql.raw(`${alias}.status = 'running' and ${alias}.lease_expires_at > ${at}`);
}

/**
 * Atomically lease one due job. A job whose serial key another job holds
 * (one per provider route, one visit per site group) waits; in a fair-share
 * lane, keys take turns (`JobClaimFilter.fairShare`).
 */
export async function claimNextJob(owner: string, leaseMs: number, filter: JobClaimFilter = {}): Promise<Job | undefined> {
	const db = await getDb();
	const timestamp = now();
	const at = timestamp.getTime();
	const leaseExpiresAt = new Date(at + leaseMs);
	const types = filter.jobTypes?.length ? [...filter.jobTypes] : undefined;
	const peerTypes = types ? sql` and peer.job_type in (${sql.join(types.map((type) => sql`${type}`), sql`, `)})` : sql``;
	const serialFree = sql`("jobs"."serial_key" is null or not exists (select 1 from jobs as busy where busy.serial_key = "jobs"."serial_key" and busy.id <> "jobs"."id" and ${liveRunning("busy", at)}))`;
	const keyLoad = sql<number>`(select count(*) from jobs as peer where peer.fair_key = "jobs"."fair_key" and peer.id <> "jobs"."id" and ${liveRunning("peer", at)}${peerTypes})`;
	const fairShare = filter.fairShare;
	return db.transaction(
		(tx) => {
			const candidate = tx
				.select()
				.from(jobs)
				.where(
					and(
						or(
							and(eq(jobs.status, "queued"), lte(jobs.nextAttemptAt, timestamp)),
							and(eq(jobs.status, "running"), lte(jobs.leaseExpiresAt, timestamp), eq(jobs.unknownExternalState, false)),
						),
						types ? inArray(jobs.jobType, types) : undefined,
						serialFree,
						fairShare ? sql`${keyLoad} < ${fairShare.perKeyLimit}` : undefined,
					),
				)
				.orderBy(...(fairShare ? [asc(keyLoad)] : []), asc(jobs.nextAttemptAt), asc(jobs.createdAt))
				.limit(1)
				.get();
			if (!candidate) return undefined;
			tx.update(jobs)
				.set({ status: "running", leaseOwner: owner, leaseExpiresAt, updatedAt: timestamp })
				.where(eq(jobs.id, candidate.id))
				.run();
			recordJobEvent(tx, candidate, "job.claimed", { owner });
			return tx.select().from(jobs).where(eq(jobs.id, candidate.id)).get();
		},
		{ behavior: "immediate" }
	);
}

export async function renewJobLease(jobId: bigint, owner: string, leaseMs: number): Promise<boolean> {
	const db = await getDb();
	return db.transaction(
		(tx) => {
			const job = tx.select({ status: jobs.status, leaseOwner: jobs.leaseOwner }).from(jobs).where(eq(jobs.id, jobId)).get();
			if (!job || job.status !== "running" || job.leaseOwner !== owner) return false;
			tx.update(jobs)
				.set({ leaseExpiresAt: new Date(Date.now() + leaseMs), updatedAt: now() })
				.where(eq(jobs.id, jobId))
				.run();
			return true;
		},
		{ behavior: "immediate" },
	);
}

/**
 * Settle the job `owner` holds: set what `changes` says and record `eventType`.
 * A job another worker took over in the meantime is left alone.
 */
function settleOwnedJob(
	jobId: bigint,
	owner: string,
	changes: (job: Job) => Partial<typeof jobs.$inferInsert>,
	event: (job: Job) => { eventType: string; data?: Record<string, unknown> },
): Promise<void> {
	return getDb().then((db) => db.transaction(
		(tx) => {
			const job = tx.select().from(jobs).where(eq(jobs.id, jobId)).get();
			if (!job || job.leaseOwner !== owner) return;
			tx.update(jobs).set({ leaseOwner: null, leaseExpiresAt: null, ...changes(job), updatedAt: now() }).where(eq(jobs.id, jobId)).run();
			const { eventType, data } = event(job);
			recordJobEvent(tx, job, eventType, data);
		},
		{ behavior: "immediate" },
	));
}

export async function completeJob(jobId: bigint, owner: string): Promise<void> {
	await settleOwnedJob(jobId, owner, () => ({ status: "completed", unknownExternalState: false }), () => ({ eventType: "job.completed" }));
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
	await settleOwnedJob(
		params.jobId,
		params.owner,
		(job) => ({ status: "queued", retryCount: job.retryCount + attempts, nextAttemptAt: new Date(Date.now() + params.afterMs), lastError: params.error }),
		(job) => ({ eventType, data: { retryCount: job.retryCount + attempts, error: params.error } }),
	);
}

export async function markJobUnknownExternalState(params: { jobId: bigint; owner: string; error: string }): Promise<void> {
	await settleOwnedJob(
		params.jobId,
		params.owner,
		() => ({ status: "unknown_external_state", unknownExternalState: true, lastError: params.error }),
		() => ({ eventType: "job.unknown_external_state", data: { error: params.error } }),
	);
}

/** Finish a retry-exhausted local job without misrepresenting it as an external ambiguity. */
export async function failJob(params: { jobId: bigint; owner: string; error: string }): Promise<void> {
	await settleOwnedJob(
		params.jobId,
		params.owner,
		() => ({ status: "failed", lastError: params.error }),
		(job) => ({ eventType: "job.failed", data: { error: params.error, retryCount: job.retryCount } }),
	);
}

export async function recoverStaleJobs(): Promise<number> {
	const db = await getDb();
	const timestamp = now();
	return db.transaction(
		(tx) => {
			const stale = tx
				.select()
				.from(jobs)
				.where(and(eq(jobs.status, "running"), lte(jobs.leaseExpiresAt, timestamp)))
				.all();
			for (const job of stale) {
				const status: JobStatus = job.unknownExternalState ? "unknown_external_state" : "queued";
				tx.update(jobs)
					.set({ status, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: timestamp, updatedAt: timestamp })
					.where(eq(jobs.id, job.id))
					.run();
				recordJobEvent(tx, job, job.unknownExternalState ? "job.recovery_requires_reconciliation" : "job.lease_recovered");
			}
			return stale.length;
		},
		{ behavior: "immediate" }
	);
}
