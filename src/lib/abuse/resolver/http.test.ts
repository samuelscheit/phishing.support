import { describe, expect, test } from "bun:test";

import { safeJsonFetch } from "./http";

describe("resolver HTTP client", () => {
	test("revalidates every HTTPS redirect target before fetching it", async () => {
		const assertedHosts: string[] = [];
		const requestedUrls: string[] = [];
		const result = await safeJsonFetch("https://rdap.example.test/domain/example.test", {
			assertPublicHost: async (host) => {
				assertedHosts.push(host);
			},
			fetch: async (input) => {
				requestedUrls.push(String(input));
				if (requestedUrls.length === 1) {
					return new Response(null, {
						status: 302,
						headers: { location: "https://rdap-authority.example.test/domain/example.test" },
					});
				}
				return new Response(JSON.stringify({ objectClassName: "domain" }), { status: 200 });
			},
		});

		expect(result).toEqual({ objectClassName: "domain" });
		expect(assertedHosts).toEqual(["rdap.example.test", "rdap-authority.example.test"]);
		expect(requestedUrls).toEqual([
			"https://rdap.example.test/domain/example.test",
			"https://rdap-authority.example.test/domain/example.test",
		]);
	});

	test("fails before following an unsafe redirect", async () => {
		const assertedHosts: string[] = [];
		const requestedUrls: string[] = [];
		await expect(
			safeJsonFetch("https://rdap.example.test/domain/example.test", {
				assertPublicHost: async (host) => {
					assertedHosts.push(host);
				},
				fetch: async (input) => {
					requestedUrls.push(String(input));
					return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
				},
			}),
		).rejects.toThrow("unsafe RDAP endpoint");
		expect(assertedHosts).toEqual(["rdap.example.test"]);
		expect(requestedUrls).toEqual(["https://rdap.example.test/domain/example.test"]);
	});

	test("enforces the response limit while streaming rather than waiting for EOF", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
			},
		});
		await expect(
			safeJsonFetch("https://rdap.example.test/domain/example.test", {
				assertPublicHost: async () => undefined,
				fetch: async () => new Response(body, { status: 200 }),
			}),
		).rejects.toThrow("size limit");
	});

	test("bounds a stalled HTTP request even when an injected client ignores abort", async () => {
		let receivedAbortSignal = false;
		await expect(
			safeJsonFetch("https://rdap.example.test/domain/example.test", {
				assertPublicHost: async () => undefined,
				httpTimeoutMs: 5,
				fetch: async (_input, init) => {
					receivedAbortSignal = init?.signal instanceof AbortSignal;
					return new Promise<Response>(() => undefined);
				},
			}),
		).rejects.toThrow("timed out");
		expect(receivedAbortSignal).toBeTrue();
	});

	test("retries a transient RDAP failure after a bounded attempt", async () => {
		let calls = 0;
		const result = await safeJsonFetch("https://rdap.example.test/domain/example.test", {
			assertPublicHost: async () => undefined,
			httpTimeoutMs: 100,
			httpRetryAttempts: 2,
			fetch: async () => {
				calls++;
				if (calls === 1) return new Response(null, { status: 503 });
				return new Response(JSON.stringify({ objectClassName: "domain" }), { status: 200 });
			},
		});
		expect(result).toEqual({ objectClassName: "domain" });
		expect(calls).toBe(2);
	});
});
