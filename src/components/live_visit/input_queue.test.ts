import { describe, expect, test } from "bun:test";

import type { LiveInput } from "@/lib/site_visit/live_input";
import { InputQueue, MAX_BATCH, type PostResult } from "./input_queue";

/** A queue on a manual clock: `tick` runs what is due, `settle` lets answered requests finish. */
function harness(answers: PostResult[] = []) {
	let now = 0;
	const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
	const posts: LiveInput[][] = [];
	const resolvers: Array<(result: PostResult) => void> = [];
	const lost: string[] = [];
	const errors: string[] = [];
	const queue = new InputQueue({
		post: (inputs) => {
			posts.push(inputs);
			const answer = answers.shift();
			return answer ? Promise.resolve(answer) : new Promise((resolve) => resolvers.push(resolve));
		},
		onLost: (error) => lost.push(error),
		onError: (error) => errors.push(error),
		schedule: (run, ms) => {
			const timer = { at: now + ms, run, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	});
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const tick = async (ms: number) => {
		now += ms;
		for (;;) {
			const due = timers.find((timer) => !timer.cancelled && timer.at <= now);
			if (!due) break;
			due.cancelled = true;
			due.run();
			await settle();
		}
	};
	return { queue, posts, resolvers, lost, errors, tick, settle };
}

const move = (x: number): LiveInput => ({ type: "pointer", phase: "move", x, y: 1, button: "left", clickCount: 1 });
const down = (x: number): LiveInput => ({ type: "pointer", phase: "down", x, y: 1, button: "left", clickCount: 1 });
const text = (value: string): LiveInput => ({ type: "text", text: value });
const ok: PostResult = { ok: true };

describe("InputQueue", () => {
	test("gathers inputs for a moment and sends them in order", async () => {
		const { queue, posts, tick } = harness([ok]);
		queue.setReady(true);
		queue.push(text("a"), down(1));
		queue.push(text("b"));
		await tick(29);
		expect(posts).toEqual([]);
		await tick(1);
		expect(posts).toEqual([[text("a"), down(1), text("b")]]);
	});

	test("keeps one request in flight and sends what came meanwhile after it", async () => {
		const { queue, posts, resolvers, tick, settle } = harness();
		queue.setReady(true);
		queue.push(text("1"));
		await tick(30);
		queue.push(text("2"));
		queue.push(text("3"));
		await tick(100);
		expect(posts).toHaveLength(1);
		resolvers[0]!(ok);
		await settle();
		await tick(29);
		expect(posts).toHaveLength(1);
		await tick(1);
		expect(posts).toEqual([[text("1")], [text("2"), text("3")]]);
	});

	test("splits more than a request's limit into ordered batches", async () => {
		const { queue, posts, tick } = harness([ok, ok, ok]);
		queue.setReady(true);
		const inputs = Array.from({ length: 2 * MAX_BATCH + 5 }, (_, index) => text(String(index)));
		queue.push(...inputs);
		await tick(30);
		await tick(30);
		await tick(30);
		expect(posts.map((batch) => batch.length)).toEqual([MAX_BATCH, MAX_BATCH, 5]);
		expect(posts.flat()).toEqual(inputs);
	});

	test("waiting pointer moves become the last one, wheel turns add up, other inputs stay", async () => {
		const { queue, posts, tick } = harness([ok]);
		queue.setReady(true);
		queue.push(move(1), move(2), move(3), down(3), move(4), move(5));
		queue.push({ type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 10 }, { type: "wheel", x: 2, y: 2, deltaX: 5, deltaY: -30 });
		await tick(30);
		expect(posts).toEqual([[move(3), down(3), move(5), { type: "wheel", x: 2, y: 2, deltaX: 5, deltaY: -20 }]]);
	});

	test("holds inputs until the browser is the driver's", async () => {
		const { queue, posts, tick } = harness([ok]);
		queue.push(text("early"));
		await tick(1_000);
		expect(posts).toEqual([]);
		queue.setReady(true);
		await tick(0);
		expect(posts).toEqual([[text("early")]]);
	});

	test("sends a batch again, first, while the agent finishes its action (409)", async () => {
		const { queue, posts, errors, tick } = harness([{ ok: false, status: 409, error: "The agent is finishing its action" }, ok]);
		queue.setReady(true);
		queue.push(text("a"), text("b"));
		await tick(30);
		queue.push(text("c"));
		await tick(399);
		expect(posts).toHaveLength(1);
		await tick(1);
		expect(posts).toEqual([[text("a"), text("b")], [text("a"), text("b"), text("c")]]);
		expect(errors).toEqual([]);
	});

	test("a 409 retry waits while the driver is not ready, and goes once it is", async () => {
		const { queue, posts, tick } = harness([{ ok: false, status: 409, error: "pausing" }, ok]);
		queue.setReady(true);
		queue.push(text("a"));
		await tick(30);
		queue.setReady(false);
		await tick(5_000);
		expect(posts).toHaveLength(1);
		queue.setReady(true);
		await tick(0);
		expect(posts).toEqual([[text("a")], [text("a")]]);
	});

	test("backs off after too many inputs (429) and keeps the batch", async () => {
		const { queue, posts, tick } = harness([{ ok: false, status: 429, error: "Too many inputs at once." }, ok]);
		queue.setReady(true);
		queue.push(text("a"));
		await tick(30);
		await tick(999);
		expect(posts).toHaveLength(1);
		await tick(1);
		expect(posts).toEqual([[text("a")], [text("a")]]);
	});

	test("a lost turn (403) drops everything waiting and says so once", async () => {
		const { queue, posts, resolvers, lost, tick, settle } = harness();
		queue.setReady(true);
		queue.push(text("a"));
		await tick(30);
		queue.push(text("b"), text("c"));
		resolvers[0]!({ ok: false, status: 403, error: "You are not driving the browser." });
		await settle();
		await tick(1_000);
		expect(lost).toEqual(["You are not driving the browser."]);
		expect(queue.pending).toEqual([]);
		expect(posts).toHaveLength(1);
	});

	test("a visit that is over (404) drops everything", async () => {
		const { queue, lost, tick } = harness([{ ok: false, status: 404, error: "The visit is not live." }]);
		queue.setReady(true);
		queue.push(text("a"));
		await tick(30);
		expect(lost).toEqual(["The visit is not live."]);
	});

	test("a refused or failed request drops its batch, reports it and goes on", async () => {
		const { queue, posts, errors, resolvers, tick, settle } = harness();
		queue.setReady(true);
		queue.push(text("bad"));
		await tick(30);
		queue.push(text("next"));
		resolvers[0]!({ ok: false, status: 400, error: "Invalid command." });
		await settle();
		await tick(30);
		expect(errors).toEqual(["Invalid command."]);
		expect(posts).toEqual([[text("bad")], [text("next")]]);
	});

	test("a request that throws counts as failed", async () => {
		const errors: string[] = [];
		const queue = new InputQueue({ post: () => Promise.reject(new Error("offline")), onLost: () => undefined, onError: (error) => errors.push(error), flushMs: 0 });
		queue.setReady(true);
		queue.push(text("a"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(errors).toEqual(["offline"]);
	});

	test("clear ignores the answer of a request in flight", async () => {
		const { queue, posts, resolvers, lost, tick, settle } = harness();
		queue.setReady(true);
		queue.push(text("a"));
		await tick(30);
		queue.clear();
		resolvers[0]!({ ok: false, status: 403, error: "gone" });
		await settle();
		await tick(100);
		expect(lost).toEqual([]);
		queue.push(text("b"));
		await tick(30);
		expect(posts).toEqual([[text("a")], [text("b")]]);
	});
});
