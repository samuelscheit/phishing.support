import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSampleArchive } from "./archive_adapter";
import type { LookupResult } from "./policy";
import { investigateDownload, type InvestigationDependencies } from "./investigate";

const bytes = Buffer.from("synthetic-downloaded-file-for-investigation-tests");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const evidence = { bytes, remoteName: "Teams setup.exe", signature: "not_signed" as const };
// The production AES builder: the store verifies every archive it writes by reading it back.
const wrap = buildSampleArchive;

let root: string;
beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), "investigate-test-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function deps(overrides: Partial<InvestigationDependencies> & { lookups?: (hash: string) => Promise<LookupResult[]> }) {
	const calls: string[] = [];
	const base: InvestigationDependencies = {
		storeRoot: undefined,
		now: () => new Date("2026-11-02T12:00:00.000Z"),
		lookups: async () => [{ provider: "malwarebazaar", state: "not_found" }],
		uploadPermitted: new Set(["malwarebazaar" as const]),
		buildArchive: wrap,
	};
	return {
		calls,
		deps: {
			...base,
			...overrides,
			lookups: async (hash: string) => { calls.push(`lookup:${hash}`); return (overrides.lookups ?? base.lookups)(hash); },
		} satisfies InvestigationDependencies,
	};
}

describe("download investigation order", () => {
	test("hashes locally before any verdict lookup is made", async () => {
		const { calls, deps: d } = deps({});
		const outcome = await investigateDownload(evidence, d);
		expect(outcome.sha256).toBe(sha256);
		expect(calls).toEqual([`lookup:${sha256}`]);
	});

	test("a known verdict short-circuits: it is recorded and no upload is decided", async () => {
		const { deps: d } = deps({ lookups: async () => [{ provider: "malwarebazaar", state: "known", verdict: "malicious" }] });
		const outcome = await investigateDownload(evidence, d);
		expect(outcome.action).toEqual({ action: "record_known_verdict", verdict: "malicious", provider: "malwarebazaar" });
	});

	test("an upload is decided only after every lookup reported not_found", async () => {
		const { deps: d } = deps({});
		const outcome = await investigateDownload(evidence, d);
		expect(outcome.action).toEqual({ action: "upload", providers: ["malwarebazaar"] });
	});

	test("a failed lookup never produces an upload decision", async () => {
		const { deps: d } = deps({ lookups: async () => [{ provider: "malwarebazaar", state: "unavailable", reason: "HTTP 500" }] });
		const outcome = await investigateDownload(evidence, d);
		expect(outcome.action).toEqual({ action: "skip", reason: "lookup_unavailable" });
	});

	test("an empty download is refused before any lookup", async () => {
		const { calls, deps: d } = deps({});
		await expect(investigateDownload({ ...evidence, bytes: Buffer.alloc(0) }, d)).rejects.toThrow("empty download");
		expect(calls).toEqual([]);
	});
});

describe("download investigation storage", () => {
	test("keeps a known sample in its protected archive when a store is configured", async () => {
		const { deps: d } = deps({ storeRoot: root, lookups: async () => [{ provider: "malwarebazaar", state: "known", verdict: "malicious" }] });
		const outcome = await investigateDownload(evidence, d);
		expect(outcome.stored?.sha256).toBe(sha256);
		expect(readdirSync(path.join(root, sha256.slice(0, 2)))).toEqual([`${sha256}.zip`]);
	});

	test("without a store, the hash and verdict are still recorded and nothing is written", async () => {
		const { deps: d } = deps({ storeRoot: undefined });
		const outcome = await investigateDownload(evidence, d);
		expect(outcome.stored).toBeUndefined();
		expect(outcome.sha256).toBe(sha256);
	});

	test("a missing provider key never fails the investigation", async () => {
		const { deps: d } = deps({ lookups: async () => [{ provider: "malwarebazaar", state: "not_configured" }] });
		const outcome = await investigateDownload(evidence, d);
		expect(outcome.action).toEqual({ action: "skip", reason: "no_provider_configured" });
	});
});

describe("download investigation without any configured store", () => {
	test("a verdict lookup still runs and the outcome is recorded when no store root is set", async () => {
		const bytesHere = Buffer.from("no-store-path-sample");
		const hash = createHash("sha256").update(bytesHere).digest("hex");
		const seen: string[] = [];
		const outcome = await investigateDownload(
			{ bytes: bytesHere, remoteName: "a.exe", signature: "not_signed" },
			{
				storeRoot: undefined,
				now: () => new Date("2026-11-02T12:00:00.000Z"),
				lookups: async (sha) => { seen.push(sha); return [{ provider: "malwarebazaar", state: "not_found" }]; },
				uploadPermitted: new Set(),
				buildArchive: wrap,
			},
		);
		expect(seen).toEqual([hash]);
		expect(outcome.stored).toBeUndefined();
		expect(outcome.action).toEqual({ action: "skip", reason: "no_upload_permitted" });
	});
});

describe("download investigation performs only the decided upload", () => {
	test("submits to each permitted provider only when the policy decided upload, with the safe leaf name", async () => {
		const submitted: Array<{ provider: string; fileName: string; bytes: number }> = [];
		const outcome = await investigateDownload(
			{ bytes: Buffer.from("probe-download-for-upload-wiring"), remoteName: "../../evil.exe", signature: "not_signed" },
			{
				storeRoot: undefined,
				now: () => new Date("2026-11-02T12:00:00.000Z"),
				lookups: async () => [
					{ provider: "malwarebazaar", state: "not_found" },
					{ provider: "virustotal", state: "not_found" },
				],
				uploadPermitted: new Set(["virustotal" as const]),
				buildArchive: wrap,
				submit: async (provider, file) => { submitted.push({ provider, fileName: file.fileName, bytes: file.bytes.byteLength }); return { state: "submitted", analysisId: "analysis-1" }; },
			},
		);
		expect(outcome.action).toEqual({ action: "upload", providers: ["virustotal"] });
		expect(submitted).toEqual([{ provider: "virustotal", fileName: expect.stringMatching(/^[a-f0-9]{16}\.bin$/), bytes: Buffer.from("probe-download-for-upload-wiring").byteLength }]);
		expect(outcome.uploads).toEqual([{ provider: "virustotal", state: "submitted", analysisId: "analysis-1" }]);
	});

	test("a skipped decision never calls the submit transport", async () => {
		let submits = 0;
		await investigateDownload(
			{ bytes: Buffer.from("known-bad-for-skip-test"), remoteName: "x", signature: "not_signed" },
			{
				storeRoot: undefined,
				now: () => new Date("2026-11-02T12:00:00.000Z"),
				lookups: async () => [{ provider: "virustotal", state: "known", verdict: "malicious" }],
				uploadPermitted: new Set(["virustotal" as const]),
				buildArchive: wrap,
				submit: async () => { submits++; return { state: "submitted", analysisId: "x" }; },
			},
		);
		expect(submits).toBe(0);
	});
});

describe("a decided upload is never dropped silently", () => {
	test("without a submit transport, a decided upload is recorded as not attempted", async () => {
		const outcome = await investigateDownload(
			{ bytes: Buffer.from("decided-upload-without-transport"), remoteName: "x", signature: "not_signed" },
			{
				storeRoot: undefined,
				now: () => new Date("2026-11-02T12:00:00.000Z"),
				lookups: async () => [{ provider: "virustotal", state: "not_found" }],
				uploadPermitted: new Set(["virustotal" as const]),
				buildArchive: wrap,
			},
		);
		expect(outcome.action).toEqual({ action: "upload", providers: ["virustotal"] });
		expect(outcome.uploads).toEqual([{ provider: "virustotal", state: "not_attempted", reason: "no upload transport configured" }]);
	});
});
