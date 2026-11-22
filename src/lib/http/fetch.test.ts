import { afterEach, describe, expect, test } from "bun:test";
import { browserUserAgent, discordUserAgent, serviceIdentity, serviceUserAgent } from "../network/service_identity";
import { fetchAs, withUserAgent, type AnswerFetch } from "./fetch";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function recorder() {
	const calls: Array<{ input: string | URL; init: RequestInit | undefined }> = [];
	const fetch = async (input: string | URL, init?: RequestInit) => {
		calls.push({ input, init });
		return new Response("ok");
	};
	return { calls, fetch };
}

describe("withUserAgent", () => {
	test("adds the User-Agent to a header record and keeps every other header as written", () => {
		expect(withUserAgent({ Accept: "application/json", "x-csrf-token": "t" }, "A/1")).toEqual({ Accept: "application/json", "x-csrf-token": "t", "user-agent": "A/1" });
	});

	test("replaces a User-Agent the caller set in any spelling, leaving exactly one", () => {
		for (const name of ["user-agent", "User-Agent", "USER-AGENT"]) {
			const headers = withUserAgent({ [name]: "Bun/1.3.0", accept: "*/*" }, "A/1") as Record<string, string>;
			expect(headers).toEqual({ accept: "*/*", "user-agent": "A/1" });
		}
	});

	test("starts from no headers", () => {
		expect(withUserAgent(undefined, "A/1")).toEqual({ "user-agent": "A/1" });
	});

	test("keeps a Headers instance a Headers instance, without changing the caller's", () => {
		const original = new Headers({ "User-Agent": "Bun/1.3.0", cookie: "a=b" });
		const headers = withUserAgent(original, "A/1");
		expect(headers).toBeInstanceOf(Headers);
		expect((headers as Headers).get("user-agent")).toBe("A/1");
		expect((headers as Headers).get("cookie")).toBe("a=b");
		expect(original.get("user-agent")).toBe("Bun/1.3.0");
	});

	test("keeps a header list a list, dropping a User-Agent entry in any spelling", () => {
		expect(withUserAgent([["Accept", "*/*"], ["User-Agent", "Bun/1.3.0"], ["user-agent", "curl/8"]], "A/1")).toEqual([["Accept", "*/*"], ["user-agent", "A/1"]]);
	});
});

describe("fetchAs", () => {
	test("sends the User-Agent with the request and passes the URL and every other option through", async () => {
		const { calls, fetch } = recorder();
		const signal = new AbortController().signal;
		const url = new URL("https://api.example.test/x");
		await fetchAs("A/1", fetch)(url, { method: "POST", body: "{}", redirect: "error", signal, headers: { "content-type": "application/json" } });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.input).toBe(url);
		expect(calls[0]!.init).toEqual({ method: "POST", body: "{}", redirect: "error", signal, headers: { "content-type": "application/json", "user-agent": "A/1" } });
	});

	test("sends it on a request without options too", async () => {
		const { calls, fetch } = recorder();
		await fetchAs("A/1", fetch)("https://api.example.test/");
		expect(calls[0]!.init).toEqual({ headers: { "user-agent": "A/1" } });
	});

	test("without a double, uses the global fetch as it is at call time", async () => {
		const send = fetchAs("A/1");
		const { calls, fetch } = recorder();
		globalThis.fetch = fetch as typeof globalThis.fetch;
		await send("https://api.example.test/");
		expect(new Headers(calls[0]!.init?.headers).get("user-agent")).toBe("A/1");
	});

	test("wraps a status-and-text double and hands back its answer unchanged", async () => {
		const answer = { status: 418, text: async () => "teapot" };
		let sent: RequestInit | undefined;
		const double: AnswerFetch = async (_input, init) => { sent = init; return answer; };
		expect(await fetchAs("A/1", double)("https://api.example.test/")).toBe(answer);
		expect(sent?.headers).toEqual({ "user-agent": "A/1" });
	});
});

describe("service User-Agents", () => {
	test("the browser UA is a full desktop Chrome UA, never a headless or bare one that AWS's gateway denies", () => {
		expect(browserUserAgent).toMatch(/^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X [\d_]+\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/[\d.]+$/);
		expect(browserUserAgent).not.toMatch(/Headless|Bun|node|curl/i);
	});

	test("the service UA names the service and where to reach it, as an RFC 9110 product token with a comment", () => {
		expect(serviceUserAgent).toBe("PhishingSupport/1 (+https://phishing.support)");
		expect(serviceUserAgent).toContain(serviceIdentity.url);
	});

	test("Discord's UA follows its required `DiscordBot ($url, $versionNumber)` form, then names the service", () => {
		expect(discordUserAgent).toMatch(/^DiscordBot \(https:\/\/[^,\s]+, \d+\)/);
		expect(discordUserAgent).toBe(`DiscordBot (https://phishing.support, 1) ${serviceUserAgent}`);
	});
});
