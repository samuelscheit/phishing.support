import { describe, expect, test } from "bun:test";
import { fetchJson, fetchText, RequestStatusError, RequestTimeoutError, retryWithTimeout } from "./bounded_fetch";

describe("bounded network requests", () => {
	test("times out an HTTP client that ignores abort and retries it", async () => {
		let calls = 0;
		await expect(fetchJson("https://rdap.example.test/domain/example.test", { method: "GET" }, {
			attempts: 2,
			timeoutMs: 5,
			retryDelayMs: 0,
			fetch: async () => {
				calls++;
				return new Promise<Response>(() => undefined);
			},
		})).rejects.toBeInstanceOf(RequestTimeoutError);
		expect(calls).toBe(2);
	});

	test("retries a stalled DNS operation and returns its eventual result", async () => {
		let calls = 0;
		await expect(retryWithTimeout(async () => {
			calls++;
			if (calls === 1) return new Promise<string>(() => undefined);
			return "ok";
		}, { label: "DNS A lookup", timeoutMs: 5, attempts: 2, retryDelayMs: 0 })).resolves.toBe("ok");
		expect(calls).toBe(2);
	});

	test("reads a text document within its size limit and answers 404 as absent", async () => {
		const options = (body: string, status = 200) => ({ attempts: 1, maxResponseBytes: 16, fetch: async () => new Response(body, { status }) });
		expect(await fetchText("https://list.example.test/top", {}, options("1,x.com\n2,a.b"))).toBe("1,x.com\n2,a.b");
		expect(await fetchText("https://list.example.test/top", {}, options("", 404))).toBeUndefined();
		await expect(fetchText("https://list.example.test/top", {}, options("x".repeat(17)))).rejects.toThrow("size limit");
		await expect(fetchText("https://list.example.test/top", {}, options("down", 503))).rejects.toBeInstanceOf(RequestStatusError);
	});

	test("still rejects a JSON body that does not parse once its attempts are spent", async () => {
		let calls = 0;
		await expect(fetchJson("https://rdap.example.test/x", {}, { attempts: 3, retryDelayMs: 0, fetch: async () => { calls++; return new Response("<html>"); } }))
			.rejects.toThrow("was not valid JSON");
		expect(calls).toBe(3);
	});
});
