import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MAX_STORED_SAMPLE_BYTES, SAMPLE_ARCHIVE_PASSWORD, sampleIsExpired, storeSample } from "./sample_store";

let root: string;
const now = new Date("2026-11-02T12:00:00.000Z");
// A stand-in archive builder: it wraps the bytes, so the test can prove the raw sample is never written.
const wrap = (entryName: string, data: Buffer, password: string) => Buffer.concat([Buffer.from(`ARCHIVE|${entryName}|${password}|`, "utf8"), data]);

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "sample-store-test-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function allFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...allFiles(full));
		else out.push(full);
	}
	return out;
}

describe("sample store", () => {
	test("stores the sample only inside its protected archive, named by its hash", async () => {
		const bytes = Buffer.from("MZ-synthetic-sample-bytes-for-a-store-test");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const stored = await storeSample({ root, bytes, remoteName: "Teams setup.exe", now, buildArchive: wrap });
		expect(stored.sha256).toBe(sha256);
		expect(stored.relativePath).toBe(`${sha256.slice(0, 2)}/${sha256}.zip`);
		expect(stored.displayName).toBe("Teams setup.exe");
		const onDisk = readFileSync(path.join(root, stored.relativePath));
		expect(onDisk.toString()).toContain(`|${sha256}.bin|${SAMPLE_ARCHIVE_PASSWORD}|`);
	});

	test("the raw sample bytes never appear as a loose file under the store", async () => {
		const bytes = Buffer.from("loose-file-check-payload");
		await storeSample({ root, bytes, remoteName: "x.exe", now, buildArchive: wrap });
		for (const file of allFiles(root)) {
			expect(file.endsWith(".zip")).toBeTrue();
			expect(readFileSync(file).equals(bytes)).toBeFalse();
		}
	});

	test("the remote filename never becomes an on-disk path", async () => {
		const bytes = Buffer.from("traversal-check-payload");
		const stored = await storeSample({ root, bytes, remoteName: "../../../../escape.exe", now, buildArchive: wrap });
		expect(stored.displayName).toBe("escape.exe");
		expect(existsSync(path.join(root, "..", "escape.exe"))).toBeFalse();
		expect(allFiles(root).every((file) => file.startsWith(root + path.sep))).toBeTrue();
	});

	test("rejects an empty download and a sample over the storage limit before writing anything", async () => {
		await expect(storeSample({ root, bytes: Buffer.alloc(0), remoteName: "a", now, buildArchive: wrap })).rejects.toThrow("empty download");
		const beforeCount = allFiles(root).length;
		const oversize = Buffer.alloc(MAX_STORED_SAMPLE_BYTES + 1);
		await expect(storeSample({ root, bytes: oversize, remoteName: "a", now, buildArchive: wrap })).rejects.toThrow("storage limit");
		expect(allFiles(root).length).toBe(beforeCount);
	});

	test("refuses a relative store root", async () => {
		await expect(storeSample({ root: "relative", bytes: Buffer.from("x"), remoteName: "a", now, buildArchive: wrap })).rejects.toThrow("absolute");
	});

	test("a failure after the temporary archive is written leaves neither a partial archive nor a temporary file", async () => {
		// Make the final name a directory: the temporary file is written, then rename fails.
		const bytes = Buffer.from("partial-write-check-payload");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const shard = path.join(root, sha256.slice(0, 2));
		mkdirSync(path.join(shard, `${sha256}.zip`), { recursive: true });
		await expect(storeSample({ root, bytes, remoteName: "a", now, buildArchive: wrap })).rejects.toThrow();
		const leftovers = readdirSync(shard).filter((name) => name.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	test("a sample is expired only once its retention window has elapsed", () => {
		const day = 86_400_000;
		expect(sampleIsExpired({ storedAt: now }, new Date(now.getTime() + day), day)).toBeFalse();
		expect(sampleIsExpired({ storedAt: now }, new Date(now.getTime() + day + 1), day)).toBeTrue();
	});
});
