import { expect } from "bun:test";

import type { DragBox, RandomSource } from "./slider_drag";

/** A reproducible random source (mulberry32). */
export function seeded(seed: number): RandomSource {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export type MouseEvent = { type: "move" | "down" | "up"; x?: number; y?: number };

/** A mouse that records what it is told; `onUp` lets a fake widget react to a release. */
export function recordingMouse(onUp: () => void = () => undefined) {
	const events: MouseEvent[] = [];
	return {
		events,
		move: async (x: number, y: number) => { events.push({ type: "move", x, y }); },
		down: async () => { events.push({ type: "down" }); },
		up: async () => { events.push({ type: "up" }); onUp(); },
	};
}

/** The pressed-and-released stretches of a recording: the pointer positions between each down and its up. */
export function drags(events: readonly MouseEvent[]): Array<{ approach: Array<{ x: number; y: number }>; held: Array<{ x: number; y: number }> }> {
	const result: ReturnType<typeof drags> = [];
	let approach: Array<{ x: number; y: number }> = [];
	let held: Array<{ x: number; y: number }> | undefined;
	for (const event of events) {
		if (event.type === "move") (held ?? approach).push({ x: event.x!, y: event.y! });
		else if (event.type === "down") held = [];
		else if (held) { result.push({ approach, held }); approach = []; held = undefined; }
	}
	return result;
}

/** A human track: pressed inside the handle, never moving left while pressed, ending 3 to 7 px (handle edge) past the rail's end. */
export function expectHumanDrag(drag: ReturnType<typeof drags>[number], handle: DragBox, rail: Pick<DragBox, "x" | "width">): void {
	const press = drag.approach.at(-1)!;
	expect(press.x).toBeGreaterThanOrEqual(handle.x);
	expect(press.x).toBeLessThanOrEqual(handle.x + handle.width);
	expect(press.y).toBeGreaterThanOrEqual(handle.y);
	expect(press.y).toBeLessThanOrEqual(handle.y + handle.height);
	// It approaches from outside the handle, not teleporting onto it.
	expect(drag.approach.length).toBeGreaterThan(1);
	expect(drag.approach[0]!.x).toBeLessThan(handle.x);
	expect(drag.held.length).toBeGreaterThan(30);
	let previous = press.x;
	for (const point of drag.held) {
		expect(point.x).toBeGreaterThanOrEqual(previous);
		previous = point.x;
	}
	const overshoot = (drag.held.at(-1)!.x - press.x) + (handle.x + handle.width) - (rail.x + rail.width);
	expect(overshoot).toBeGreaterThanOrEqual(3 - 1e-9);
	expect(overshoot).toBeLessThanOrEqual(7 + 1e-9);
	// Not a straight line: the pointer drifts vertically.
	expect(new Set(drag.held.map((point) => point.y.toFixed(2))).size).toBeGreaterThan(5);
}
