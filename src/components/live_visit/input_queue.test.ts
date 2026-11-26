import { describe, expect, test } from "bun:test";

import type { LiveInput } from "@/lib/site_visit/live_input";
import { GATHER_MS, InputQueue, MAX_BATCH } from "./input_queue";

/** A queue whose timers the test runs by hand, sending into `sent` while `up`. */
function harness() {
	const sent: LiveInput[][] = [];
	const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
	const state = { up: true };
	const queue = new InputQueue({
		send: (inputs) => {
			if (!state.up) return false;
			sent.push(inputs);
			return true;
		},
		schedule: (run, ms) => {
			const timer = { run, ms, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	});
	const tick = () => {
		for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
	};
	return { queue, sent, timers, tick, state };
}

const move = (x: number): LiveInput => ({ type: "pointer", phase: "move", x, y: 1, button: "left", clickCount: 1 });
const down = (x: number): LiveInput => ({ type: "pointer", phase: "down", x, y: 1, button: "left", clickCount: 1 });
const wheel = (deltaY: number): LiveInput => ({ type: "wheel", x: 1, y: 1, deltaX: 0, deltaY });

describe("InputQueue", () => {
	test("a click or a key goes out at once, with the moves that came before it", () => {
		const { queue, sent } = harness();
		queue.setReady(true);
		queue.push(move(1), move(2), move(3));
		expect(sent).toEqual([]);
		queue.push(down(3));
		expect(sent).toEqual([[move(3), down(3)]]);
		queue.push({ type: "text", text: "a" });
		expect(sent.at(-1)).toEqual([{ type: "text", text: "a" }]);
	});

	test("moves and wheel turns gather for one frame: moves become their last, wheel turns their sum", () => {
		const { queue, sent, timers, tick } = harness();
		queue.setReady(true);
		queue.push(move(1));
		queue.push(move(2));
		queue.push(wheel(10), wheel(-3));
		expect(timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms)).toEqual([GATHER_MS]);
		tick();
		expect(sent).toEqual([[move(2), wheel(7)]]);
	});

	test("waits until the browser is the driver's and the socket is up; keeps what could not be sent", () => {
		const { queue, sent, tick, state } = harness();
		queue.push({ type: "text", text: "a" });
		tick();
		expect(sent).toEqual([]);
		state.up = false;
		queue.setReady(true);
		expect(queue.pending).toEqual([{ type: "text", text: "a" }]);
		state.up = true;
		queue.push({ type: "text", text: "b" });
		expect(sent).toEqual([[{ type: "text", text: "a" }, { type: "text", text: "b" }]]);
		expect(queue.pending).toEqual([]);
	});

	test("sends at most a message's worth at once, in order", () => {
		const { queue, sent } = harness();
		const typed = Array.from({ length: MAX_BATCH * 2 + 5 }, (_, index): LiveInput => ({ type: "text", text: String(index) }));
		queue.push(...typed);
		queue.setReady(true);
		expect(sent.map((batch) => batch.length)).toEqual([MAX_BATCH, MAX_BATCH, 5]);
		expect(sent.flat()).toEqual(typed);
	});

	test("clear drops what waits and the gathering frame", () => {
		const { queue, sent, tick } = harness();
		queue.setReady(true);
		queue.push(move(1));
		queue.clear();
		tick();
		expect(sent).toEqual([]);
		expect(queue.pending).toEqual([]);
	});
});
