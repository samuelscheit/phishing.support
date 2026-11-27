import { describe, expect, test } from "bun:test";

import { Semaphore } from "./semaphore";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("Semaphore", () => {
	test("rejects a capacity that is not a positive integer", () => {
		for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new Semaphore(capacity)).toThrow(RangeError);
	});

	test("grants up to its capacity at once, then queues in arrival order", async () => {
		const semaphore = new Semaphore(2);
		const first = await semaphore.acquire();
		const second = await semaphore.acquire();
		expect(semaphore.available).toBe(0);
		const order: string[] = [];
		const third = semaphore.acquire().then((release) => { order.push("third"); return release; });
		const fourth = semaphore.acquire().then((release) => { order.push("fourth"); return release; });
		await tick();
		expect(semaphore.waiting).toBe(2);
		expect(order).toEqual([]);
		second();
		await tick();
		expect(order).toEqual(["third"]);
		first();
		await tick();
		expect(order).toEqual(["third", "fourth"]);
		(await third)();
		(await fourth)();
		expect(semaphore.available).toBe(2);
		expect(semaphore.waiting).toBe(0);
	});

	test("a release counts once, however often it is called", async () => {
		const semaphore = new Semaphore(1);
		const release = await semaphore.acquire();
		release();
		release();
		expect(semaphore.available).toBe(1);
		const again = await semaphore.acquire();
		release();
		expect(semaphore.available).toBe(0);
		again();
		expect(semaphore.available).toBe(1);
	});

	test("an aborted waiter leaves the queue with its signal's reason and never takes a slot", async () => {
		const semaphore = new Semaphore(1);
		const held = await semaphore.acquire();
		const controller = new AbortController();
		const reason = new Error("job cancelled");
		const waiting = semaphore.acquire(controller.signal);
		const next = semaphore.acquire();
		await tick();
		expect(semaphore.waiting).toBe(2);
		controller.abort(reason);
		await expect(waiting).rejects.toBe(reason);
		expect(semaphore.waiting).toBe(1);
		held();
		// The slot skips the aborted waiter and goes to the next one.
		const release = await next;
		expect(semaphore.available).toBe(0);
		release();
		expect(semaphore.available).toBe(1);
	});

	test("an already aborted signal is refused at once, even with free slots", async () => {
		const semaphore = new Semaphore(1);
		const reason = new Error("gone");
		await expect(semaphore.acquire(AbortSignal.abort(reason))).rejects.toBe(reason);
		expect(semaphore.available).toBe(1);
	});

	test("an abort after the grant changes nothing", async () => {
		const semaphore = new Semaphore(1);
		const controller = new AbortController();
		const release = await semaphore.acquire(controller.signal);
		controller.abort();
		expect(semaphore.available).toBe(0);
		release();
		expect(semaphore.available).toBe(1);
	});
});
