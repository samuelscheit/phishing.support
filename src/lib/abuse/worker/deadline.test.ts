import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { AbuseRepository } from "../repository";
import { jobs } from "../schema";
import { AbuseWorker } from "./index";

useTemporaryDatabase();

async function jobRow(id: bigint) {
	const db = await getDb();
	return db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}

const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

/** A control-lane job without a route: a timeout queues it again once. */
const controlJob = () => AbuseRepository.enqueueJob({ jobType: "monitor_provider_reply", payload: {}, dedupeKey: "deadline-job" });

describe("an interrupted job winds down before it is settled", () => {
	test("a timed-out job is queued again only after its work ended, its lease renewed meanwhile", async () => {
		const job = await controlJob();
		let leaseAtAbort: Date | null = null;
		let leaseAfterWindDown: Date | null = null;
		let woundDownAt = 0;
		const worker = new AbuseWorker({
			controlJobTimeoutMs: 1_000,
			abortGraceMs: 10_000,
			leaseMs: 1_500,
			processJob: async (claimed, signal) => {
				await aborted(signal!);
				leaseAtAbort = (await jobRow(claimed.id)).leaseExpiresAt;
				// Cancelling a browser lease and closing pages takes a while.
				await Bun.sleep(1_300);
				leaseAfterWindDown = (await jobRow(claimed.id)).leaseExpiresAt;
				woundDownAt = Date.now();
				throw signal!.reason;
			},
		});
		expect(await worker.processOne()).toBeTrue();
		const returnedAt = Date.now();
		expect(woundDownAt).toBeGreaterThan(0);
		expect(returnedAt).toBeGreaterThanOrEqual(woundDownAt);
		// The job stayed leased while the old attempt wound down, so no other worker claimed it.
		expect(leaseAfterWindDown!.getTime()).toBeGreaterThan(leaseAtAbort!.getTime());
		const row = await jobRow(job.id);
		expect(row).toMatchObject({ status: "queued", retryCount: 1, leaseOwner: null });
		expect(row.lastError).toContain("exceeded its 1000 ms execution deadline");
	}, 10_000);

	test("work that ends at the abort is settled at once: the grace is a bound, not a wait", async () => {
		const job = await controlJob();
		const worker = new AbuseWorker({
			controlJobTimeoutMs: 1_000,
			abortGraceMs: 30_000,
			processJob: async (_claimed, signal) => {
				await aborted(signal!);
				throw signal!.reason;
			},
		});
		const started = Date.now();
		await worker.processOne();
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(await jobRow(job.id)).toMatchObject({ status: "queued", retryCount: 1 });
	}, 10_000);

	test("work that ignores the abort is given up on after the grace", async () => {
		const job = await controlJob();
		const worker = new AbuseWorker({ controlJobTimeoutMs: 1_000, abortGraceMs: 200, processJob: () => new Promise<void>(() => undefined) });
		const started = Date.now();
		await worker.processOne();
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(1_150);
		expect(elapsed).toBeLessThan(3_000);
		expect(await jobRow(job.id)).toMatchObject({ status: "queued", retryCount: 1 });
	}, 10_000);

	test("a stopping worker waits for the job's wind-down and leaves the job leased for startup recovery", async () => {
		const job = await controlJob();
		let started!: () => void;
		const running = new Promise<void>((resolve) => { started = resolve; });
		let woundDownAt = 0;
		const worker = new AbuseWorker({
			abortGraceMs: 10_000,
			processJob: async (_claimed, signal) => {
				started();
				await aborted(signal!);
				await Bun.sleep(200);
				woundDownAt = Date.now();
			},
		});
		const processing = worker.processOne();
		await running;
		await worker.stop();
		await processing;
		expect(woundDownAt).toBeGreaterThan(0);
		expect(await jobRow(job.id)).toMatchObject({ status: "running", retryCount: 0 });
	}, 10_000);
});
