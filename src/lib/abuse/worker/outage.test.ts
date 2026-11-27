import { describe, expect, test } from "bun:test";

import { OutageBackoff, OUTAGE_BACKOFF_MS } from "./outage";

function clocked(delays?: readonly number[]) {
	let now = 1_000_000;
	const backoff = new OutageBackoff(delays, () => now);
	return { backoff, advance: (ms: number) => { now += ms; } };
}

describe("OutageBackoff", () => {
	test("pauses 30 s, 1 min, 2 min, 5 min, then 15 min for each further outage", () => {
		const { backoff, advance } = clocked();
		expect(backoff.remainingMs()).toBe(0);
		const pauses: number[] = [];
		for (let outage = 0; outage < 7; outage++) {
			pauses.push(backoff.recordOutage());
			advance(pauses.at(-1)!);
			expect(backoff.remainingMs()).toBe(0);
		}
		expect(pauses).toEqual([...OUTAGE_BACKOFF_MS, 15 * 60_000, 15 * 60_000]);
	});

	test("outages during a running pause are the same outage: they neither extend it nor step the backoff", () => {
		const { backoff, advance } = clocked([100, 200, 400]);
		expect(backoff.recordOutage()).toBe(100);
		advance(40);
		expect(backoff.recordOutage()).toBe(60);
		expect(backoff.recordOutage()).toBe(60);
		advance(60);
		expect(backoff.recordOutage()).toBe(200);
	});

	test("a success lifts the pause at once and starts the backoff over", () => {
		const { backoff, advance } = clocked([100, 200, 400]);
		backoff.recordOutage();
		advance(100);
		backoff.recordOutage();
		expect(backoff.remainingMs()).toBe(200);
		backoff.recordSuccess();
		expect(backoff.remainingMs()).toBe(0);
		expect(backoff.recordOutage()).toBe(100);
	});

	test("needs at least one delay", () => {
		expect(() => new OutageBackoff([])).toThrow(RangeError);
	});
});
