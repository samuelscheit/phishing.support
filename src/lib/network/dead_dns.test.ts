import { describe, expect, test } from "bun:test";

import { confirmHostNxdomain, isTunnelConnectionFailure } from "./dead_dns";
import { WebsiteCaptureFailedError, WebsiteUnreachableError } from "../website/archive/errors";

type Answer = { status?: number; body?: unknown } | "hang" | "throw";

/** A DoH server answering each record type as told, recording what it was asked. */
function doh(answers: Partial<Record<"A" | "AAAA", Answer>>) {
	const asked: Array<{ name: string | null; type: string | null; accept: string | null }> = [];
	const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const type = url.searchParams.get("type") as "A" | "AAAA";
		asked.push({ name: url.searchParams.get("name"), type, accept: new Headers(init?.headers).get("accept") });
		const answer = answers[type] ?? { body: { Status: 0, Answer: [{ data: "203.0.113.7" }] } };
		if (answer === "throw") throw new TypeError("fetch failed");
		if (answer === "hang") {
			return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
		}
		return Response.json(answer.body ?? null, { status: answer.status ?? 200 });
	};
	return { fetch, asked };
}

const nx = { body: { Status: 3 } };

describe("isTunnelConnectionFailure", () => {
	test("finds ERR_TUNNEL_CONNECTION_FAILED in a reason, an error, a wrapper's cause, or a capture's route failures", () => {
		expect(isTunnelConnectionFailure("net::ERR_TUNNEL_CONNECTION_FAILED at https://gone.example/")).toBeTrue();
		expect(isTunnelConnectionFailure(new Error("net::ERR_TUNNEL_CONNECTION_FAILED"))).toBeTrue();
		expect(isTunnelConnectionFailure(new Error("capture failed", { cause: new Error("net::ERR_TUNNEL_CONNECTION_FAILED") }))).toBeTrue();
		expect(isTunnelConnectionFailure(new WebsiteCaptureFailedError([new WebsiteUnreachableError("phishing", "net::ERR_TUNNEL_CONNECTION_FAILED at https://gone.example/")]))).toBeTrue();
		expect(isTunnelConnectionFailure("net::ERR_NAME_NOT_RESOLVED at https://gone.example/")).toBeTrue();
		for (const value of [new Error("net::ERR_CONNECTION_REFUSED"), undefined, null, 42]) expect(isTunnelConnectionFailure(value)).toBeFalse();
	});
});

describe("confirmHostNxdomain", () => {
	test("asks public DoH for A and AAAA in JSON, and confirms only an NXDOMAIN answer", async () => {
		const server = doh({ A: nx, AAAA: nx });
		expect(await confirmHostNxdomain("Gone.Example.", { fetch: server.fetch })).toBeTrue();
		expect(server.asked).toEqual([
			{ name: "gone.example", type: "A", accept: "application/dns-json" },
			{ name: "gone.example", type: "AAAA", accept: "application/dns-json" },
		]);
	});

	test("one NXDOMAIN answer confirms when the other query got no answer at all", async () => {
		expect(await confirmHostNxdomain("gone.example", doh({ A: nx, AAAA: "throw" }))).toBeTrue();
		expect(await confirmHostNxdomain("gone.example", { ...doh({ A: { status: 503 }, AAAA: nx }), timeoutMs: 50 })).toBeTrue();
	});

	test("a name that resolves, or answers NOERROR or SERVFAIL for either type, is never dead", async () => {
		expect(await confirmHostNxdomain("alive.example", doh({}))).toBeFalse();
		expect(await confirmHostNxdomain("alive.example", doh({ A: nx, AAAA: { body: { Status: 0 } } }))).toBeFalse();
		expect(await confirmHostNxdomain("flaky.example", doh({ A: nx, AAAA: { body: { Status: 2 } } }))).toBeFalse();
	});

	test("SERVFAIL, refusals, HTTP errors, unreadable answers, transport failures and timeouts never confirm", async () => {
		const unanswered: Answer[] = [
			{ body: { Status: 2 } },
			{ body: { Status: 5 } },
			{ status: 500 },
			{ status: 404 },
			{ body: null },
			{ body: { Status: "3" } },
			{ body: [3] },
			"throw",
			"hang",
		];
		for (const answer of unanswered) {
			expect(await confirmHostNxdomain("unknown.example", { ...doh({ A: answer, AAAA: answer }), timeoutMs: 30 }), JSON.stringify(answer)).toBeFalse();
		}
	});

	test("an IP literal, special-use name, or malformed name is never asked about", async () => {
		const server = doh({ A: nx, AAAA: nx });
		for (const host of ["203.0.113.7", "::1", "[2001:db8::1]", "hidden.onion", "service.local", "host.internal", "localhost", "a.i2p", "", "  ", "bad host.example", "-bad.example", "a..example", `${"a".repeat(64)}.example`]) {
			expect(await confirmHostNxdomain(host, { fetch: server.fetch }), host).toBeFalse();
		}
		expect(server.asked).toEqual([]);
	});

	test("an abort rejects with its reason, before or during the queries", async () => {
		const reason = new Error("visit cancelled");
		const server = doh({ A: "hang", AAAA: "hang" });
		await expect(confirmHostNxdomain("gone.example", { fetch: server.fetch, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
		expect(server.asked).toEqual([]);
		const controller = new AbortController();
		const pending = confirmHostNxdomain("gone.example", { fetch: server.fetch, signal: controller.signal, timeoutMs: 10_000 });
		setTimeout(() => controller.abort(reason), 10);
		const started = Date.now();
		await expect(pending).rejects.toBe(reason);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
