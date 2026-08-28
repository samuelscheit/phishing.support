import { describe, expect, test } from "bun:test";
import { queryDns } from "../website_info";

describe("website DNS collection", () => {
	test("keeps partial records when one DNS operation stalls", async () => {
		let aCalls = 0;
		const result = await queryDns("example.test", {
			regionalDns: false,
			timeoutMs: 5,
			retryAttempts: 2,
			retryDelayMs: 0,
			dns: {
				resolve4: async () => {
					aCalls++;
					return new Promise<string[]>(() => undefined);
				},
				resolve6: async () => ["2001:db8::1"],
				resolveNs: async () => ["ns.example.test"],
				resolveMx: async () => [],
				resolveCname: async () => [],
				resolveTxt: async () => [],
			},
		});

		expect(aCalls).toBe(2);
		expect(result.A).toEqual([]);
		expect(result.NS).toEqual(["ns.example.test"]);
		expect(result.errors?.A).toContain("timed out");
	});
});
