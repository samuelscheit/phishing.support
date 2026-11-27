import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { abuseEvents, jobs, type JobType } from "../schema";
import { claimNextJob, completeJob, deferJob, enqueueJob, failJob, recoverStaleJobs, retryJob, type JobClaimFilter } from "./jobs";

useTemporaryDatabase();

const LEASE_MS = 60_000;
const TYPE: JobType = "analyze_kit_sibling";
const lane: JobClaimFilter = { jobTypes: [TYPE], fairShare: { perKeyLimit: 3 } };

let clock = Date.parse("2026-11-20T00:00:00Z");
/** A job due now, each one created a moment after the last so their order is fixed. */
async function queue(fairKey: string | undefined, extra: { serialKey?: string; jobType?: JobType } = {}) {
	clock += 1_000;
	const job = await enqueueJob({ jobType: extra.jobType ?? TYPE, fairKey, serialKey: extra.serialKey, payload: { n: clock } });
	(await getDb()).update(jobs).set({ createdAt: new Date(clock), nextAttemptAt: new Date(clock - 60 * 60_000) }).where(eq(jobs.id, job.id)).run();
	return job;
}

const claim = async (filter: JobClaimFilter = lane) => (await claimNextJob("worker", LEASE_MS, filter))?.fairKey ?? undefined;
const expireLease = async (id: bigint) => (await getDb()).update(jobs).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(jobs.id, id)).run();

describe("the fair-share claim", () => {
	test("keys take turns: a flood queued first waits behind a later reporter's next job", async () => {
		for (let index = 0; index < 10; index++) await queue("ip:flood");
		await queue("ip:other");
		await queue("ip:other");
		expect([await claim(), await claim(), await claim(), await claim(), await claim()]).toEqual(["ip:flood", "ip:other", "ip:flood", "ip:other", "ip:flood"]);
		// The flood holds its limit of 3; the other key has nothing left.
		expect(await claim()).toBeUndefined();
	});

	test("a lone key never holds more than its limit, even when every other slot is idle", async () => {
		for (let index = 0; index < 10; index++) await queue("ip:flood");
		expect([await claim(), await claim(), await claim()]).toEqual(["ip:flood", "ip:flood", "ip:flood"]);
		expect(await claim()).toBeUndefined();
		// A finished job frees one of its slots, for its own next job.
		const [running] = (await getDb()).select().from(jobs).where(eq(jobs.status, "running")).all();
		await completeJob(running!.id, "worker");
		expect(await claim()).toBe("ip:flood");
		expect(await claim()).toBeUndefined();
	});

	test("a key's expired lease frees its slot, and the job itself is claimed again", async () => {
		const first = await queue("ip:a");
		await queue("ip:a");
		await queue("ip:a");
		await queue("ip:a");
		expect([await claim(), await claim(), await claim(), await claim()]).toEqual(["ip:a", "ip:a", "ip:a", undefined]);
		await expireLease(first.id);
		const reclaimed = await claimNextJob("worker-2", LEASE_MS, lane);
		expect(reclaimed?.id).toBe(first.id);
		expect(reclaimed?.leaseOwner).toBe("worker-2");
	});

	test("only the lane's own job types count against a key", async () => {
		const other = await queue("ip:a", { jobType: "search_campaign_kits" });
		expect((await claimNextJob("worker", LEASE_MS, { jobTypes: ["search_campaign_kits"] }))?.id).toBe(other.id);
		for (let index = 0; index < 4; index++) await queue("ip:a");
		expect([await claim(), await claim(), await claim(), await claim()]).toEqual(["ip:a", "ip:a", "ip:a", undefined]);
	});

	test("jobs without a fair key are not limited; a lane without fair share claims oldest first", async () => {
		for (let index = 0; index < 5; index++) await queue(undefined);
		for (let index = 0; index < 5; index++) expect(await claimNextJob("worker", LEASE_MS, lane)).toBeDefined();
		await queue("ip:late");
		await queue("ip:late");
		expect(await claim({ jobTypes: [TYPE] })).toBe("ip:late");
	});
});

describe("the serial key", () => {
	test("one job per key runs at a time; the next is claimed once the first ends", async () => {
		const first = await queue("ip:a", { serialKey: "site:slon10.to" });
		const second = await queue("ip:b", { serialKey: "site:slon10.to" });
		const elsewhere = await queue("ip:a", { serialKey: "site:other.example" });
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(first.id);
		// The second waits although it is due and its fair key is idle.
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(elsewhere.id);
		expect(await claimNextJob("worker", LEASE_MS, lane)).toBeUndefined();
		await completeJob(first.id, "worker");
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(second.id);
	});

	test("an expired lease releases the key", async () => {
		const first = await queue("ip:a", { serialKey: "site:x.example" });
		const second = await queue("ip:a", { serialKey: "site:x.example" });
		await claimNextJob("worker", LEASE_MS, lane);
		await expireLease(first.id);
		// The expired job, older, is claimed again before its sibling; the sibling waits behind it.
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(first.id);
		expect(await claimNextJob("worker", LEASE_MS, lane)).toBeUndefined();
		await failJob({ jobId: first.id, owner: "worker", error: "gone" });
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(second.id);
	});
});

describe("a job without a report", () => {
	test("goes through its whole lifecycle without writing report events", async () => {
		const job = await queue("ip:a");
		expect(job.reportId).toBeNull();
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(job.id);
		await retryJob({ jobId: job.id, owner: "worker", error: "once", afterMs: -1 });
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(job.id);
		await deferJob({ jobId: job.id, owner: "worker", error: "no browser", afterMs: -1 });
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(job.id);
		await expireLease(job.id);
		expect(await recoverStaleJobs()).toBe(1);
		expect((await claimNextJob("worker", LEASE_MS, lane))?.id).toBe(job.id);
		await completeJob(job.id, "worker");
		const stored = (await getDb()).select().from(jobs).where(eq(jobs.id, job.id)).get()!;
		expect(stored).toMatchObject({ status: "completed", retryCount: 1, leaseOwner: null });
		expect((await getDb()).select().from(abuseEvents).all()).toEqual([]);
	});
});
