/**
 * Where each site's dot sits on the campaign's time line: left by when it
 * was found, stacked in lanes around the line where dots would overlap
 * (0 on the line, then 1 above, 2 below, …, at most `SIDE` per side), so a
 * burst reads as a column of the same height at any scale. Sites beyond a
 * full stack are counted into that spot's "+N".
 */
export const DOT = 14;
export const LANE = DOT + 2;
export const SIDE = 3;

export type Placed<T> = { site: T; x: number; offset: number };
export type Overflow<T> = { x: number; sites: T[] };

export function placeDots<T extends { firstSeenAt: string }>(sites: readonly T[], width: number, start: number, end: number): { dots: Placed<T>[]; more: Overflow<T>[] } {
	const span = Math.max(1, end - start);
	const lanes: number[] = [];
	const dots: Placed<T>[] = [];
	const more: Overflow<T>[] = [];
	// The x of the current stack: dots closer to it than a dot's width share it, so a stack is a straight column.
	let column = -Infinity;
	for (const site of [...sites].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))) {
		let x = DOT / 2 + ((Date.parse(site.firstSeenAt) - start) / span) * Math.max(0, width - DOT);
		if (x - column < DOT) x = column;
		else column = x;
		let lane = lanes.findIndex((last) => x - last >= LANE);
		if (lane < 0 && lanes.length < 2 * SIDE + 1) lane = lanes.length;
		if (lane < 0) {
			const spot = more.at(-1);
			if (spot && x - spot.x < LANE) spot.sites.push(site);
			else more.push({ x, sites: [site] });
			continue;
		}
		lanes[lane] = x;
		dots.push({ site, x, offset: lane === 0 ? 0 : (lane % 2 ? 1 : -1) * Math.ceil(lane / 2) * LANE });
	}
	return { dots, more };
}
