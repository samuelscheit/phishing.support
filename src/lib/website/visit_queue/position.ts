import { and, eq, gt } from "drizzle-orm";

import { jobs } from "@/lib/abuse/schema";
import { getDb } from "@/lib/db";
import { visitJobKey, WEBSITE_VISIT_JOB } from "./queue";

/**
 * Where a queued case stands in the visit queue: its place in line, or the
 * time its visit is due (an automatic retry's backoff), or the case whose
 * visit it waits for (one visit per serial key at a time).
 */
export type VisitQueueState =
	| { kind: "queued"; position: number }
	| { kind: "scheduled"; notBefore: string }
	| { kind: "waiting"; forSubmissionId: string };

type Line = { id: bigint; fairKey: string | null; nextAttemptAt: Date; createdAt: Date };
const inClaimOrder = (a: Line, b: Line) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || Number(a.id - b.id);

/**
 * The place of one due job among the due jobs of a fair-share lane. Keys take
 * turns, so before the job's k-th turn of its own key each other key has had
 * up to k turns: ahead are the k-1 older jobs of its own key and, of every
 * other key, at most k. Exact for keys taking strict turns; a key's slot
 * limit and visit length shift it a little.
 */
export function fairSharePosition(line: readonly Line[], jobId: bigint): number | undefined {
	const target = line.find((job) => job.id === jobId);
	if (!target) return undefined;
	const byKey = new Map<string | null, Line[]>();
	for (const job of [...line].sort(inClaimOrder)) byKey.set(job.fairKey, [...(byKey.get(job.fairKey) ?? []), job]);
	const own = byKey.get(target.fairKey)!;
	const turn = own.findIndex((job) => job.id === jobId) + 1;
	let ahead = turn - 1;
	for (const [key, queued] of byKey) if (key !== target.fairKey) ahead += Math.min(queued.length, turn);
	return ahead + 1;
}

/** Where a case's visit stands, while one waits; undefined when none does. */
export async function websiteVisitQueueState(submissionId: bigint, now = new Date()): Promise<VisitQueueState | undefined> {
	const db = await getDb();
	const job = db.select().from(jobs).where(and(eq(jobs.dedupeKey, visitJobKey(submissionId)), eq(jobs.status, "queued"))).get();
	if (!job) return undefined;
	if (job.nextAttemptAt > now) return { kind: "scheduled", notBefore: job.nextAttemptAt.toISOString() };
	if (job.serialKey) {
		const holder = db.select({ payload: jobs.payload }).from(jobs)
			.where(and(eq(jobs.serialKey, job.serialKey), eq(jobs.status, "running"), gt(jobs.leaseExpiresAt, now)))
			.get();
		const holderCase = holder?.payload?.submissionId;
		if (typeof holderCase === "string" && holderCase !== submissionId.toString()) return { kind: "waiting", forSubmissionId: holderCase };
	}
	const line = db.select({ id: jobs.id, fairKey: jobs.fairKey, nextAttemptAt: jobs.nextAttemptAt, createdAt: jobs.createdAt }).from(jobs)
		.where(and(eq(jobs.jobType, WEBSITE_VISIT_JOB), eq(jobs.status, "queued")))
		.all()
		.filter((queued) => queued.nextAttemptAt <= now);
	return { kind: "queued", position: fairSharePosition(line, job.id) ?? 1 };
}
