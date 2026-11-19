import { describe, expect, test } from "bun:test";

import { DOT, LANE, SIDE, placeDots } from "./timeline_layout";

const DAY = 86_400_000;
const start = Date.parse("2026-08-19T08:00:00Z");
const at = (day: number, minute = 0) => ({ firstSeenAt: new Date(start + day * DAY + minute * 60_000).toISOString(), id: `${day}-${minute}` });

describe("placeDots", () => {
	test("spread-out sites sit on the line, at their time", () => {
		const { dots, more } = placeDots([at(0), at(10), at(20)], 400, start, start + 20 * DAY);
		expect(more).toEqual([]);
		expect(dots.map((dot) => dot.offset)).toEqual([0, 0, 0]);
		expect(dots[0]!.x).toBe(DOT / 2);
		expect(dots[2]!.x).toBe(400 - DOT / 2);
	});

	test("a burst stacks in one straight column, alternating above and below", () => {
		const burst = Array.from({ length: 5 }, (_, minute) => at(3, minute * 5));
		const { dots } = placeDots(burst, 400, start, start + 20 * DAY);
		expect(new Set(dots.map((dot) => dot.x)).size).toBe(1);
		expect(dots.map((dot) => dot.offset)).toEqual([0, LANE, -LANE, 2 * LANE, -2 * LANE]);
	});

	test("stacks are capped and the rest goes into one +N per spot, losing no site", () => {
		const sites = [];
		for (let day = 0; day < 69; day++) {
			const n = [5, 20, 33, 50, 60].includes(day) ? 30 : day % 3 === 0 ? 1 : 0;
			for (let i = 0; i < n; i++) sites.push(at(day, i * 10));
		}
		for (const width of [300, 940]) {
			const { dots, more } = placeDots(sites, width, start, start + 69 * DAY);
			expect(dots.length + more.reduce((sum, spot) => sum + spot.sites.length, 0)).toBe(sites.length);
			expect(Math.max(...dots.map((dot) => Math.abs(dot.offset)))).toBeLessThanOrEqual(SIDE * LANE);
			expect(more.length).toBeGreaterThanOrEqual(5);
		}
	});

	test("one site, or all at one instant, does not divide by zero", () => {
		expect(placeDots([at(0)], 300, start, start).dots[0]!.x).toBe(DOT / 2);
		const same = placeDots([at(0), at(0)], 300, start, start);
		expect(same.dots.map((dot) => dot.offset)).toEqual([0, LANE]);
	});

	test("input order does not matter", () => {
		const forward = placeDots([at(0), at(1), at(1, 1)], 300, start, start + DAY);
		const backward = placeDots([at(1, 1), at(1), at(0)], 300, start, start + DAY);
		expect(backward.dots.map((dot) => dot.site.id)).toEqual(forward.dots.map((dot) => dot.site.id));
	});
});
