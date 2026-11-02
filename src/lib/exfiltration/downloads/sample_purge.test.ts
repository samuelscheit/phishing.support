import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { purgeExpiredSamples } from "./sample_purge";
import { startSamplePurgeSchedule } from "./sample_purge_job";

const DAY = 86_400_000;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
let root: string;

beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), "sample-purge-test-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** A sample archive at its fan-out path, created now (its birth time is the real creation instant). */
function archive(hash: string): string {
	const dir = path.join(root, hash.slice(0, 2));
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${hash}.zip`);
	writeFileSync(file, "archive-bytes");
	return file;
}

describe("sample retention purge", () => {
	test("removes an archive once its retention window has fully elapsed, and keeps a fresh one", async () => {
		const fresh = archive(HASH_B);
		const old = archive(HASH_A);
		// The purge clock is a future instant: the archive is older than a 1-day window only relative to it.
		const later = new Date(Date.now() + 2 * DAY);
		const result = await purgeExpiredSamples({ root, now: later, retentionMs: DAY });
		expect(result.removed).toBe(2);
		expect(existsSync(old)).toBeFalse();
		expect(existsSync(fresh)).toBeFalse();
	});

	test("keeps an archive that is still inside its window", async () => {
		const file = archive(HASH_A);
		const result = await purgeExpiredSamples({ root, now: new Date(), retentionMs: 30 * DAY });
		expect(result.kept).toBeGreaterThanOrEqual(1);
		expect(existsSync(file)).toBeTrue();
	});

	test("never follows or deletes a symbolic link, even one that points at a sample", async () => {
		const target = path.join(root, "outside-target.bin");
		writeFileSync(target, "must-survive");
		const dir = path.join(root, "cc");
		mkdirSync(dir, { recursive: true });
		const link = path.join(dir, `${"c".repeat(64)}.zip`);
		symlinkSync(target, link);
		await purgeExpiredSamples({ root, now: new Date(Date.now() + 365 * DAY), retentionMs: DAY });
		expect(lstatSync(link).isSymbolicLink()).toBeTrue();
		expect(existsSync(target)).toBeTrue();
	});

	test("leaves files that are not SHA-256 archives untouched and counts them as skipped", async () => {
		const dir = path.join(root, "dd");
		mkdirSync(dir, { recursive: true });
		const stray = path.join(dir, "notes.txt");
		writeFileSync(stray, "keep me");
		const result = await purgeExpiredSamples({ root, now: new Date(Date.now() + 365 * DAY), retentionMs: DAY });
		expect(existsSync(stray)).toBeTrue();
		expect(result.skipped).toBeGreaterThanOrEqual(1);
	});

	test("ignores a top-level entry that is not a two-character fan-out directory", async () => {
		const weird = path.join(root, "not-a-fanout");
		mkdirSync(weird, { recursive: true });
		writeFileSync(path.join(weird, `${"e".repeat(64)}.zip`), "x");
		await purgeExpiredSamples({ root, now: new Date(Date.now() + 365 * DAY), retentionMs: DAY });
		expect(existsSync(path.join(weird, `${"e".repeat(64)}.zip`))).toBeTrue();
	});

	test("a missing store is an empty purge, not an error", async () => {
		const missing = path.join(root, "never-created");
		expect(await purgeExpiredSamples({ root: missing, now: new Date(), retentionMs: DAY })).toEqual({ removed: 0, kept: 0, skipped: 0 });
	});

	test("refuses a relative store root, so no relative path can be deleted from", async () => {
		await expect(purgeExpiredSamples({ root: "relative/store", now: new Date(), retentionMs: DAY })).rejects.toThrow("absolute path");
	});
});

describe("sample purge schedule", () => {
	test("runs on each tick, reports a failed pass without stopping, and stops when asked", async () => {
		let runs = 0;
		const errors: unknown[] = [];
		const stop = startSamplePurgeSchedule({
			intervalMs: 5,
			run: async () => {
				runs += 1;
				if (runs === 1) throw new Error("disk briefly unavailable");
				return { removed: 0, kept: 0, skipped: 0 };
			},
			onError: (error) => errors.push(error),
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		stop();
		const countAtStop = runs;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(runs).toBeGreaterThan(1);
		expect(errors.length).toBe(1);
		expect(runs).toBe(countAtStop);
	});
});
