import { describe, expect, test } from "bun:test";

import { retryDelayMs } from "./worker";

describe("how long a failed job waits", () => {
	test("backs off exponentially, up to fifteen minutes", () => {
		expect([0, 1, 5, 9, 10, 20].map((count) => retryDelayMs(new Error("x"), count))).toEqual([1_000, 2_000, 32_000, 512_000, 900_000, 900_000]);
	});

	test("waits as long as the error says its dependency needs, when that is longer", () => {
		const backingOff = Object.assign(new Error("Cloudflare dashboard login failed."), { retryAfterMs: 540_000.4 });
		expect(retryDelayMs(backingOff, 0)).toBe(540_001);
		// A shorter wait never shortens the backoff.
		expect(retryDelayMs(Object.assign(new Error("x"), { retryAfterMs: 10 }), 6)).toBe(64_000);
	});

	test("caps what an error may ask for at an hour and ignores what is not a duration", () => {
		expect(retryDelayMs(Object.assign(new Error("x"), { retryAfterMs: 24 * 60 * 60_000 }), 0)).toBe(60 * 60_000);
		for (const retryAfterMs of [Number.NaN, Number.POSITIVE_INFINITY, "600000", null]) {
			expect(retryDelayMs(Object.assign(new Error("x"), { retryAfterMs }), 2)).toBe(4_000);
		}
		expect(retryDelayMs(undefined, 0)).toBe(1_000);
		expect(retryDelayMs("plain string", 0)).toBe(1_000);
	});
});
