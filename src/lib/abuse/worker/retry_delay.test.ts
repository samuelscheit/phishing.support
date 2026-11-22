import { describe, expect, test } from "bun:test";

import { deliveryRetryDelayMs, MAX_DELIVERY_RETRY_MS, MAX_DELIVERY_SENDS, retryDelayMs } from "./retry";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../util/date_time";

describe("resending after a temporary delivery failure", () => {
	const start = new Date("2026-11-20T00:00:00Z");
	const at = (ms: number) => new Date(start.getTime() + ms);
	/** `count` sends, an hour apart. */
	const sends = (count: number) => Array.from({ length: count }, (_, index) => at(index * HOUR_MS));

	test("doubles from fifteen minutes with each send", () => {
		expect([1, 2, 3, 4, 5].map((count) => deliveryRetryDelayMs(sends(count), at(count * HOUR_MS))))
			.toEqual([15 * MINUTE_MS, 30 * MINUTE_MS, HOUR_MS, 2 * HOUR_MS, 4 * HOUR_MS]);
	});

	test(`stops after ${MAX_DELIVERY_SENDS} sends, however recent`, () => {
		expect(MAX_DELIVERY_SENDS).toBe(6);
		expect(deliveryRetryDelayMs(sends(MAX_DELIVERY_SENDS), at(6 * HOUR_MS))).toBeUndefined();
		expect(deliveryRetryDelayMs(sends(MAX_DELIVERY_SENDS + 3), at(10 * HOUR_MS))).toBeUndefined();
	});

	test("stops when the resend would come more than three days after the first send", () => {
		expect(MAX_DELIVERY_RETRY_MS).toBe(3 * DAY_MS);
		// A server that sends its notice days later (a queue that kept trying).
		expect(deliveryRetryDelayMs([start], at(3 * DAY_MS - 15 * MINUTE_MS))).toBe(15 * MINUTE_MS);
		expect(deliveryRetryDelayMs([start], at(3 * DAY_MS - 15 * MINUTE_MS + 1))).toBeUndefined();
		expect(deliveryRetryDelayMs([at(2 * DAY_MS), start], at(3 * DAY_MS))).toBeUndefined();
	});

	test("a notice naming no recorded send counts as the first", () => {
		expect(deliveryRetryDelayMs([], start)).toBe(15 * MINUTE_MS);
	});

	test("a send stamped later than now (clock skew) does not extend the window", () => {
		expect(deliveryRetryDelayMs([at(HOUR_MS)], start)).toBe(15 * MINUTE_MS);
	});
});

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
