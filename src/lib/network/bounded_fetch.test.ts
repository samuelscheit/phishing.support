import { describe, expect, test } from "bun:test";
import { fetchJson, RequestTimeoutError, retryWithTimeout } from "./bounded_fetch";

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
});
