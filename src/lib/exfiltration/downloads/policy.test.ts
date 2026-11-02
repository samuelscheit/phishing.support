import { describe, expect, test } from "bun:test";

import { decideDownloadAction, type LookupResult } from "./policy";
import { lookupMalwareBazaar } from "./malwarebazaar";

const notFound: LookupResult = { provider: "malwarebazaar", state: "not_found" };
const unconfigured: LookupResult = { provider: "virustotal", state: "not_configured" };
const permitted = new Set(["malwarebazaar" as const]);

describe("download policy: known verdicts short-circuit", () => {
	test("a known malicious verdict is recorded and nothing is uploaded", () => {
		const action = decideDownloadAction({
			lookups: [{ provider: "malwarebazaar", state: "known", verdict: "malicious" }],
			uploadPermitted: permitted,
		});
		expect(action).toEqual({ action: "record_known_verdict", verdict: "malicious", provider: "malwarebazaar" });
	});

	test("a known verdict wins even when another provider is unavailable", () => {
		const action = decideDownloadAction({
			lookups: [
				{ provider: "virustotal", state: "unavailable", reason: "HTTP 503" },
				{ provider: "malwarebazaar", state: "known", verdict: "suspicious" },
			],
			uploadPermitted: permitted,
		});
		expect(action).toMatchObject({ action: "record_known_verdict", verdict: "suspicious" });
	});
});

describe("download policy: uploads are gated", () => {
	test("uploads only when a malware basis and every configured provider reported not_found", () => {
		expect(decideDownloadAction({ lookups: [notFound, unconfigured], uploadPermitted: permitted, signature: "not_signed" }))
			.toEqual({ action: "upload", providers: ["malwarebazaar"] });
	});

	test("an unavailable lookup means unknown, and unknown never uploads", () => {
		const action = decideDownloadAction({
			lookups: [{ provider: "virustotal", state: "unavailable", reason: "timeout" }, notFound],
			uploadPermitted: permitted,
		});
		expect(action).toEqual({ action: "skip", reason: "lookup_unavailable" });
	});

	test("a configured provider that has not answered not_found blocks the upload", () => {
		const action = decideDownloadAction({
			lookups: [{ provider: "virustotal", state: "not_configured" }, { provider: "malwarebazaar", state: "unavailable", reason: "x" }],
			uploadPermitted: permitted,
		});
		expect(action).toEqual({ action: "skip", reason: "lookup_unavailable" });
	});

	test("no upload happens without an explicit operator permission", () => {
		expect(decideDownloadAction({ lookups: [notFound], uploadPermitted: new Set() }))
			.toEqual({ action: "skip", reason: "no_upload_permitted" });
	});

	test("with no provider configured at all, the file is skipped cleanly and no key is required", () => {
		expect(decideDownloadAction({ lookups: [unconfigured], uploadPermitted: permitted }))
			.toEqual({ action: "skip", reason: "no_provider_configured" });
	});

	test("the upload order is deterministic", () => {
		const action = decideDownloadAction({
			lookups: [notFound, { provider: "virustotal", state: "not_found" }],
			uploadPermitted: new Set(["virustotal" as const, "malwarebazaar" as const]),
			signature: "not_signed",
		});
		expect(action).toEqual({ action: "upload", providers: ["malwarebazaar", "virustotal"] });
	});
});

describe("MalwareBazaar hash lookup", () => {
	const sha256 = "a".repeat(64);

	test("sends the documented get_info query with the Auth-Key header", async () => {
		let captured: { body: string; headers: Record<string, string> } | undefined;
		const result = await lookupMalwareBazaar({
			sha256,
			authKey: " key-123 ",
			fetch: async (_url, init) => {
				captured = { body: String(init?.body), headers: init?.headers as Record<string, string> };
				return Response.json({ query_status: "hash_not_found" });
			},
		});
		expect(result).toEqual({ provider: "malwarebazaar", state: "not_found" });
		expect(captured?.body).toBe(`query=get_info&hash=${sha256}`);
		expect(captured?.headers["Auth-Key"]).toBe("key-123");
	});

	test("a missing key is not_configured and makes no network request", async () => {
		let calls = 0;
		const result = await lookupMalwareBazaar({ sha256, authKey: undefined, fetch: async () => { calls++; return new Response("{}"); } });
		expect(result).toEqual({ provider: "malwarebazaar", state: "not_configured" });
		expect(calls).toBe(0);
	});

	test("an invalid hash is never sent to the provider", async () => {
		let calls = 0;
		const result = await lookupMalwareBazaar({ sha256: "not-a-hash", authKey: "k", fetch: async () => { calls++; return new Response("{}"); } });
		expect(result).toMatchObject({ state: "unavailable" });
		expect(calls).toBe(0);
	});

	test("a documented sample record is a known malicious verdict only when it echoes the queried hash", async () => {
		const hit = await lookupMalwareBazaar({ sha256, authKey: "k", fetch: async () => Response.json({ query_status: "ok", sha256_hash: sha256 }) });
		expect(hit).toEqual({ provider: "malwarebazaar", state: "known", verdict: "malicious" });
		const other = await lookupMalwareBazaar({ sha256, authKey: "k", fetch: async () => Response.json({ query_status: "ok", sha256_hash: "b".repeat(64) }) });
		expect(other.state).toBe("unavailable");
	});

	test("every non-documented outcome is unavailable, never not_found", async () => {
		for (const response of [
			new Response("server error", { status: 500 }),
			Response.json({ query_status: "illegal_hash" }),
			Response.json({ query_status: "no_hash_provided" }),
			new Response("not json", { status: 200 }),
		]) {
			const result = await lookupMalwareBazaar({ sha256, authKey: "k", fetch: async () => response });
			expect(result.state).toBe("unavailable");
		}
	});

	test("a transport failure is unavailable, never a clean verdict", async () => {
		const result = await lookupMalwareBazaar({ sha256, authKey: "k", fetch: async () => { throw new TypeError("fetch failed"); } });
		expect(result).toEqual({ provider: "malwarebazaar", state: "unavailable", reason: "transport failure" });
	});
});

describe("download policy: a permitted provider must be queried first", () => {
	test("never uploads to a permitted provider that was not part of the lookups", () => {
		// VirusTotal is permitted for upload, but no lookup for it ran: no verdict was sought.
		const action = decideDownloadAction({
			lookups: [notFound],
			uploadPermitted: new Set(["malwarebazaar" as const, "virustotal" as const]),
		});
		expect(action).toEqual({ action: "skip", reason: "lookup_unavailable" });
	});

	test("uploads only to permitted providers that were themselves queried and returned not_found", () => {
		const action = decideDownloadAction({
			lookups: [{ provider: "virustotal", state: "not_found" }, notFound],
			uploadPermitted: new Set(["malwarebazaar" as const, "virustotal" as const]),
			signature: "not_signed",
		});
		expect(action).toEqual({ action: "upload", providers: ["malwarebazaar", "virustotal"] });
	});
});

describe("download policy: the publisher-signature gate", () => {
	const clean = { lookups: [notFound], uploadPermitted: permitted };

	test("an unsigned or unexpectedly signed file is eligible for upload", () => {
		for (const signature of ["not_signed"] as const) {
			expect(decideDownloadAction({ ...clean, signature })).toEqual({ action: "upload", providers: ["malwarebazaar"] });
		}
	});

	test("a file from a trusted signer is never uploaded", () => {
		expect(decideDownloadAction({ ...clean, signature: "signed_binary" })).toEqual({ action: "skip", reason: "signed_binary" });
	});

	test("an unverified signature state fails closed and never uploads", () => {
		expect(decideDownloadAction({ ...clean, signature: "unknown" })).toEqual({ action: "skip", reason: "signature_unverified" });
	});

	test("a missing signature state fails closed as well", () => {
		expect(decideDownloadAction({ ...clean })).toEqual({ action: "skip", reason: "signature_unverified" });
	});
});

describe("download policy: probe downloads may be uploaded", () => {
	const probe = { lookups: [notFound], uploadPermitted: permitted };

	test("a probe download with no verdict from any queried provider is uploaded", () => {
		expect(decideDownloadAction({ ...probe, signature: "not_signed" })).toEqual({ action: "upload", providers: ["malwarebazaar"] });
	});

	test("a probe download that already has a known verdict is recorded, never uploaded", () => {
		expect(decideDownloadAction({ ...probe, lookups: [{ provider: "malwarebazaar", state: "known", verdict: "malicious" }], signature: "not_signed" }))
			.toMatchObject({ action: "record_known_verdict" });
	});

	test("a probe download whose provider lookup failed is never uploaded", () => {
		expect(decideDownloadAction({ ...probe, lookups: [{ provider: "malwarebazaar", state: "unavailable", reason: "HTTP 500" }], signature: "not_signed" }))
			.toEqual({ action: "skip", reason: "lookup_unavailable" });
	});

	test("a probe download that is a signed installer is not uploaded", () => {
		expect(decideDownloadAction({ ...probe, signature: "signed_binary" })).toEqual({ action: "skip", reason: "signed_binary" });
	});
});
