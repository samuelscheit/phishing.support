import { describe, expect, test } from "bun:test";
import { queryPort43 } from "./port43";

describe("port-43 WHOIS boundary", () => {
	test("bounds and retries a WHOIS adapter that never settles", async () => {
		let calls = 0;
		const result = await queryPort43("whois.example.test", "example.test", {
			assertPublicHost: async () => undefined,
			port43TimeoutMs: 5,
			port43Attempts: 2,
			port43Query: async () => {
				calls++;
				return new Promise<string>(() => undefined);
			},
		});
		expect(calls).toBe(2);
		expect(result.raw).toBeUndefined();
		expect(result.error).toContain("timed out");
	});

	test("returns the successful retry response", async () => {
		let calls = 0;
		const result = await queryPort43("whois.example.test", "example.test", {
			assertPublicHost: async () => undefined,
			port43TimeoutMs: 100,
			port43Attempts: 2,
			port43Query: async () => {
				calls++;
				if (calls === 1) throw new Error("temporary connection reset");
				return "abuse-mailbox: abuse@example.test";
			},
		});
		expect(calls).toBe(2);
		expect(result).toEqual({ raw: "abuse-mailbox: abuse@example.test" });
	});
});
