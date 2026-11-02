import { describe, expect, test } from "bun:test";

import { lookupVirusTotal } from "./virustotal";

const sha256 = "a".repeat(64);
const report = (attributes: Record<string, unknown>) => Response.json({ data: { id: sha256, attributes: { sha256, ...attributes } } });

describe("VirusTotal hash lookup", () => {
	test("sends the hash in the path and the key in the x-apikey header", async () => {
		let url = "";
		let headers: Record<string, string> = {};
		await lookupVirusTotal({
			sha256,
			apiKey: " vt-key ",
			fetch: async (input, init) => {
				url = String(input);
				headers = init?.headers as Record<string, string>;
				return new Response("{}", { status: 404 });
			},
		});
		expect(url).toBe(`https://www.virustotal.com/api/v3/files/${sha256}`);
		expect(headers["x-apikey"]).toBe("vt-key");
	});

	test("a missing key makes no request and is not_configured", async () => {
		let calls = 0;
		expect(await lookupVirusTotal({ sha256, apiKey: undefined, fetch: async () => { calls++; return new Response("{}"); } }))
			.toEqual({ provider: "virustotal", state: "not_configured" });
		expect(calls).toBe(0);
	});

	test("the documented NotFoundError 404 is the only status that means no verdict", async () => {
		const result = await lookupVirusTotal({ sha256, apiKey: "k", fetch: async () => Response.json({ error: { code: "NotFoundError", message: "not found" } }, { status: 404 }) });
		expect(result).toEqual({ provider: "virustotal", state: "not_found" });
	});

	test("a 404 that is not NotFoundError is unavailable, never a clean verdict", async () => {
		const result = await lookupVirusTotal({ sha256, apiKey: "k", fetch: async () => new Response("gateway", { status: 404 }) });
		expect(result.state).toBe("unavailable");
	});

	test("quota, credential, and server failures are unavailable, never not_found", async () => {
		for (const status of [401, 429, 500, 503]) {
			const result = await lookupVirusTotal({ sha256, apiKey: "k", fetch: async () => new Response("{}", { status }) });
			expect(result.state).toBe("unavailable");
		}
	});

	test("a transport failure is unavailable", async () => {
		const result = await lookupVirusTotal({ sha256, apiKey: "k", fetch: async () => { throw new TypeError("fetch failed"); } });
		expect(result).toEqual({ provider: "virustotal", state: "unavailable", reason: "transport failure" });
	});

	test("a malicious or suspicious analysis is a known verdict", async () => {
		expect(await lookupVirusTotal({ sha256, apiKey: "k", fetch: async () => report({ last_analysis_stats: { malicious: 4, suspicious: 0, harmless: 60, undetected: 20 } }) }))
			.toEqual({ provider: "virustotal", state: "known", verdict: "malicious" });
		expect(await lookupVirusTotal({ sha256, apiKey: "k", fetch: async () => report({ last_analysis_stats: { malicious: 0, suspicious: 2, harmless: 60, undetected: 20 } }) }))
			.toEqual({ provider: "virustotal", state: "known", verdict: "suspicious" });
	});

	test("a clean analysis is a known benign verdict", async () => {
		expect(await lookupVirusTotal({ sha256, apiKey: "k", fetch: async () => report({ last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 70, undetected: 10 } }) }))
			.toEqual({ provider: "virustotal", state: "known", verdict: "benign" });
	});

	test("a report for a different hash is never accepted as this file's verdict", async () => {
		const result = await lookupVirusTotal({
			sha256,
			apiKey: "k",
			fetch: async () => Response.json({ data: { id: "b".repeat(64), attributes: { sha256: "b".repeat(64), last_analysis_stats: { malicious: 0, suspicious: 0 } } } }),
		});
		expect(result).toEqual({ provider: "virustotal", state: "unavailable", reason: "report does not match the queried hash" });
	});

	test("a 200 without analysis statistics is unavailable, not benign", async () => {
		const result = await lookupVirusTotal({ sha256, apiKey: "k", fetch: async () => report({}) });
		expect(result).toEqual({ provider: "virustotal", state: "unavailable", reason: "report has no analysis statistics" });
	});

	test("an invalid hash is never sent", async () => {
		let calls = 0;
		expect(await lookupVirusTotal({ sha256: "not-a-hash", apiKey: "k", fetch: async () => { calls++; return new Response("{}"); } }))
			.toMatchObject({ state: "unavailable" });
		expect(calls).toBe(0);
	});
});
