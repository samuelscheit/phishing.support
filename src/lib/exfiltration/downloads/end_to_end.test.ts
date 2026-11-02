import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSampleArchive } from "./archive_adapter";
import { investigateDownload } from "./investigate";
import { readProtectedArchive } from "./protected_archive";
import { SAMPLE_ARCHIVE_PASSWORD } from "./sample_store";

const BSDTAR = "/usr/bin/bsdtar";
let root: string;

beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), "investigate-e2e-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("download investigation with the real protected archive", () => {
	test("a file with no verdict is kept in an AES archive that opens to the exact sample", async () => {
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
		// The archive opens with the documented password and yields the exact sample digest.
		const opened = await readProtectedArchive(readFileSync(archivePath), SAMPLE_ARCHIVE_PASSWORD);
		expect(opened.data.equals(bytes)).toBeTrue();
		// bsdtar (libarchive) is the analyst tool for AES ZIP on macOS; the system unzip cannot read AES.
		if (!existsSync(BSDTAR)) return;
		const extracted = Bun.spawnSync([BSDTAR, "-xOf", archivePath, "--passphrase", SAMPLE_ARCHIVE_PASSWORD]);
		expect(extracted.exitCode).toBe(0);
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
