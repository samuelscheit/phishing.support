import { describe, expect, test } from "bun:test";

import { passiveDnsHistory, passiveDnsHosts, virusTotalPassiveDns, type PassiveDnsSource } from "./passive_dns";

const KEY = { VIRUSTOTAL_API_KEY: " vt-key " };

function resolution(host: string, ip: string, date: number) {
	return { type: "resolution", id: `${ip}${host}`, attributes: { date, host_name: host, ip_address: ip, resolver: "VirusTotal" } };
}

/** A VirusTotal stand-in answering per host, recording each request. */
function virusTotal(answers: Record<string, Response | (() => Promise<Response>)>) {
	const requests: Array<{ url: string; key: string | null }> = [];
	const fetch = async (url: string, init?: RequestInit) => {
		requests.push({ url, key: new Headers(init?.headers).get("x-apikey") });
		const host = decodeURIComponent(new URL(url).pathname.split("/")[4]!);
		const answer = answers[host];
		if (!answer) return Response.json({ error: { code: "NotFoundError" } }, { status: 404 });
		return typeof answer === "function" ? answer() : answer.clone();
	};
	return { fetch, requests };
}

describe("passive DNS hosts", () => {
	test("a subdomain is asked with its site and the site's www", () => {
		expect(passiveDnsHosts("TRK.Cause-Writer-Sister-Several.run.")).toEqual(["trk.cause-writer-sister-several.run", "cause-writer-sister-several.run", "www.cause-writer-sister-several.run"]);
	});

	test("a registrable domain or its www is not asked twice", () => {
		expect(passiveDnsHosts("example.com")).toEqual(["example.com", "www.example.com"]);
		expect(passiveDnsHosts("www.example.com")).toEqual(["www.example.com", "example.com"]);
	});

	test("a tenant of a shared platform stops at the tenant, never the platform", () => {
		expect(passiveDnsHosts("login.victim-kit.pages.dev")).toEqual(["login.victim-kit.pages.dev", "victim-kit.pages.dev", "www.victim-kit.pages.dev"]);
	});

	test("an invalid name asks nothing", () => {
		expect(passiveDnsHosts("not a domain")).toEqual([]);
	});
});

describe("VirusTotal passive DNS", () => {
	test("reads the host's resolutions with the key, keeps public addresses of that host only, and dates them", async () => {
		const vt = virusTotal({
			"login.example.com": Response.json({
				data: [
					resolution("login.example.com", "104.21.46.90", 1_792_300_425),
					resolution("LOGIN.example.com", "2001:4860:0:0::0068", 1_790_000_000),
					resolution("login.example.com", "10.0.0.5", 1_790_000_000),
					resolution("other.example.com", "8.8.8.8", 1_790_000_000),
					resolution("login.example.com", "not-an-ip", 1_790_000_000),
				],
				meta: { count: 5 },
			}),
		});
		const history = await passiveDnsHistory("login.example.com", { sources: [virusTotalPassiveDns({ environment: KEY, fetch: vt.fetch })] });
		expect(vt.requests).toEqual([
			{ url: "https://www.virustotal.com/api/v3/domains/login.example.com/resolutions?limit=40", key: "vt-key" },
			{ url: "https://www.virustotal.com/api/v3/domains/example.com/resolutions?limit=40", key: "vt-key" },
			{ url: "https://www.virustotal.com/api/v3/domains/www.example.com/resolutions?limit=40", key: "vt-key" },
		]);
		expect(history).toEqual({
			hosts: ["login.example.com", "example.com", "www.example.com"],
			sources: ["virustotal"],
			records: [
				{ host: "login.example.com", ip: "104.21.46.90", type: "A", lastSeen: "2026-10-18T05:13:45.000Z", sources: ["virustotal"] },
				{ host: "login.example.com", ip: "2001:4860::68", type: "AAAA", lastSeen: "2026-09-21T14:13:20.000Z", sources: ["virustotal"] },
			],
			// 404 NotFoundError: never seen, which is an answer, not a failure.
			errors: [],
		});
	});

	test("without a key every host records why, and nothing is requested or thrown", async () => {
		const vt = virusTotal({});
		const history = await passiveDnsHistory("example.com", { sources: [virusTotalPassiveDns({ environment: { VIRUSTOTAL_API_KEY: "  " }, fetch: vt.fetch })] });
		expect(vt.requests).toEqual([]);
		expect(history.records).toEqual([]);
		expect(history.errors).toEqual([
			"passive DNS virustotal for example.com: VIRUSTOTAL_API_KEY is not set",
			"passive DNS virustotal for www.example.com: VIRUSTOTAL_API_KEY is not set",
		]);
	});

	test("a refused key, an exhausted quota, a malformed answer and a timeout fail only their host", async () => {
		const ok = Response.json({ data: [resolution("www.kit-a.com", "8.8.8.8", 1_790_000_000)] });
		const cases: Array<[string, Response | (() => Promise<Response>), string]> = [
			["the API key was refused (HTTP 401)", new Response("{}", { status: 401 }), "401"],
			["quota exhausted (HTTP 429)", new Response("{}", { status: 429 }), "429"],
			["returned an invalid resolutions response", Response.json({ data: [{ attributes: { host_name: "kit-a.com" } }] }), "malformed"],
			["Request to www.virustotal.com failed with HTTP 503.", new Response("", { status: 503 }), "503"],
			["timed out after 20ms", () => new Promise<Response>(() => {}), "timeout"],
		];
		for (const [message, answer] of cases) {
			const vt = virusTotal({ "kit-a.com": answer, "www.kit-a.com": ok });
			const history = await passiveDnsHistory("kit-a.com", { sources: [virusTotalPassiveDns({ environment: KEY, fetch: vt.fetch, timeoutMs: 20 })] });
			expect(history.records.map(({ host, ip }) => `${host} ${ip}`)).toEqual(["www.kit-a.com 8.8.8.8"]);
			expect(history.errors).toHaveLength(1);
			expect(history.errors[0]).toStartWith("passive DNS virustotal for kit-a.com: ");
			expect(history.errors[0]).toContain(message);
			// One attempt each: a retried 429 would spend the quota the next lookup needs.
			expect(vt.requests.filter(({ url }) => url.includes("/domains/kit-a.com/"))).toHaveLength(1);
		}
	});
});

describe("passive DNS history", () => {
	const source = (name: "virustotal", records: Record<string, Array<{ ip: string; firstSeen?: string; lastSeen: string }>>): PassiveDnsSource => ({
		name,
		resolutions: async (host) => (records[host] ?? []).map((record) => ({ host, ...record })),
	});

	test("merges sightings of one address per host: earliest first, latest last, most recent first", async () => {
		const history = await passiveDnsHistory("www.example.com", {
			sources: [
				source("virustotal", {
					"www.example.com": [
						{ ip: "8.8.8.8", firstSeen: "2026-10-05T00:00:00Z", lastSeen: "2026-10-09T00:00:00Z" },
						{ ip: "8.8.8.8", firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-07T00:00:00Z" },
						{ ip: "8.8.4.4", lastSeen: "2026-10-20T00:00:00Z" },
						{ ip: "1.1.1.1", lastSeen: "not a date" },
					],
					"example.com": [{ ip: "8.8.8.8", lastSeen: "2026-10-20T00:00:00Z" }],
				}),
			],
		});
		expect(history.records).toEqual([
			{ host: "www.example.com", ip: "8.8.4.4", type: "A", lastSeen: "2026-10-20T00:00:00.000Z", sources: ["virustotal"] },
			{ host: "example.com", ip: "8.8.8.8", type: "A", lastSeen: "2026-10-20T00:00:00.000Z", sources: ["virustotal"] },
			{ host: "www.example.com", ip: "8.8.8.8", type: "A", firstSeen: "2026-10-01T00:00:00.000Z", lastSeen: "2026-10-09T00:00:00.000Z", sources: ["virustotal"] },
		]);
	});

	test("one failing source leaves the others' answers", async () => {
		const history = await passiveDnsHistory("example.com", {
			sources: [
				{ name: "virustotal", resolutions: async () => { throw new Error("down"); } },
				source("virustotal", { "example.com": [{ ip: "8.8.8.8", lastSeen: "2026-10-20T00:00:00Z" }] }),
			],
		});
		expect(history.records.map(({ ip }) => ip)).toEqual(["8.8.8.8"]);
		expect(history.errors).toEqual(["passive DNS virustotal for example.com: down", "passive DNS virustotal for www.example.com: down"]);
	});

	test("cancellation is not swallowed as a source error", async () => {
		const controller = new AbortController();
		const history = passiveDnsHistory("example.com", {
			signal: controller.signal,
			sources: [{ name: "virustotal", resolutions: async () => { controller.abort(new Error("canceled")); throw new Error("aborted"); } }],
		});
		await expect(history).rejects.toThrow("canceled");
	});
});
