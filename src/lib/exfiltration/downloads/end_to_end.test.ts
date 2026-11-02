import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSampleArchive } from "./archive_adapter";
import { investigateDownload } from "./investigate";

const UNZIP = "/usr/bin/unzip";
let root: string;

beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), "investigate-e2e-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("download investigation with the real protected archive", () => {
	test("a file with no verdict is kept in a password archive that the system unzip can open", async () => {
		const bytes = Buffer.from("MZ-synthetic-end-to-end-sample-".repeat(64));
		const outcome = await investigateDownload(
			{ bytes, remoteName: "Teams-x64.zip", phishingBasis: "malware_delivery", origin: "other", signature: "not_signed" },
			{
				storeRoot: root,
				now: () => new Date("2026-11-02T12:00:00.000Z"),
				lookups: async () => [{ provider: "malwarebazaar", state: "not_found" }],
				uploadPermitted: new Set(),
				buildArchive: buildSampleArchive,
			},
		);
		expect(outcome.action).toEqual({ action: "skip", reason: "no_upload_permitted" });
		expect(outcome.stored).toBeDefined();
		const archivePath = path.join(root, outcome.stored!.relativePath);
		expect(existsSync(archivePath)).toBeTrue();
		// The raw bytes are not present in plaintext anywhere in the stored file.
		expect(readFileSync(archivePath).includes(bytes)).toBeFalse();
		if (!existsSync(UNZIP)) return;
		const test = Bun.spawnSync([UNZIP, "-t", "-P", "infected", archivePath]);
		expect(test.exitCode).toBe(0);
		const extracted = Bun.spawnSync([UNZIP, "-p", "-P", "infected", archivePath]);
		expect(Buffer.from(extracted.stdout).equals(bytes)).toBeTrue();
	});

	test("a known verdict is recorded and the sample is still kept, with no upload", async () => {
		const bytes = Buffer.from("known-verdict-end-to-end-sample");
		const outcome = await investigateDownload(
			{ bytes, remoteName: "x.exe", phishingBasis: "malware_delivery", origin: "other", signature: "not_signed" },
			{
				storeRoot: root,
				now: () => new Date("2026-11-02T12:00:00.000Z"),
				lookups: async () => [{ provider: "malwarebazaar", state: "known", verdict: "malicious" }],
				uploadPermitted: new Set(["malwarebazaar" as const]),
				buildArchive: buildSampleArchive,
			},
		);
		expect(outcome.action).toEqual({ action: "record_known_verdict", verdict: "malicious", provider: "malwarebazaar" });
		expect(outcome.stored).toBeDefined();
	});
});
