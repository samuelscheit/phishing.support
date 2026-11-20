import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { publishEvent, subscribeToEvents } from "./event_transport";

const unique = () => `test:${crypto.randomUUID()}`;

/** What a subscriber that connects now is replayed. */
async function replay(topic: string, count: number): Promise<unknown[]> {
	const subscriber = await subscribeToEvents(topic);
	const iterator = subscriber[Symbol.asyncIterator]();
	const events: unknown[] = [];
	for (let index = 0; index < count; index++) events.push((await iterator.next()).value);
	subscriber.close();
	return events;
}

/** Whether a topic kept any history: a late subscriber would see nothing, so a published event is the first thing it gets. */
async function keptHistory(topic: string): Promise<boolean> {
	const subscriber = await subscribeToEvents(topic);
	const iterator = subscriber[Symbol.asyncIterator]();
	const first = await Promise.race([iterator.next().then(() => true), Bun.sleep(20).then(() => false)]);
	subscriber.close();
	return first;
}

afterEach(() => { (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.(); });

describe("event transport", () => {
	test("a subscriber that connects late is replayed what the topic published, and then gets what follows", async () => {
		const topic = unique();
		await publishEvent(topic, { type: "analysis.step", step: "analysis_run", progress: 10 });
		await publishEvent(topic, { type: "analysis.step", step: "analysis_run", progress: 50 });
		const subscriber = await subscribeToEvents(topic);
		const iterator = subscriber[Symbol.asyncIterator]();
		expect(await iterator.next()).toEqual({ done: false, value: { type: "analysis.step", step: "analysis_run", progress: 10 } });
		expect(await iterator.next()).toEqual({ done: false, value: { type: "analysis.step", step: "analysis_run", progress: 50 } });
		const next = iterator.next();
		await publishEvent(topic, { type: "run.completed" });
		expect(await next).toEqual({ done: false, value: { type: "run.completed" } });
		subscriber.close();
	});

	test("a topic keeps its latest 500 events", async () => {
		const topic = unique();
		for (let index = 0; index < 600; index++) await publishEvent(topic, index);
		expect(await replay(topic, 3)).toEqual([100, 101, 102]);
	});

	test("a finished topic's history is freed after its retention, a running one's is not", async () => {
		const topic = unique();
		const running = unique();
		let now = Date.now();
		spyOn(Date, "now").mockImplementation(() => now);
		await publishEvent(running, { type: "run.started" });
		await publishEvent(topic, { type: "analysis.step", step: "analysis_run", progress: 50 });
		await publishEvent(topic, { type: "analysis.step", step: "completed", progress: 100 });
		expect(await keptHistory(topic)).toBeTrue();
		now += 11 * 60_000;
		// Any later publication sweeps what has expired.
		await publishEvent(unique(), { type: "run.started" });
		expect(await keptHistory(topic)).toBeFalse();
		expect(await keptHistory(running)).toBeTrue();
	});

	test("a topic that publishes again after a finish is no longer finished", async () => {
		const topic = unique();
		let now = Date.now();
		spyOn(Date, "now").mockImplementation(() => now);
		await publishEvent(topic, { type: "run.completed" });
		await publishEvent(topic, { type: "run.started" });
		now += 11 * 60_000;
		await publishEvent(unique(), { type: "run.started" });
		expect(await keptHistory(topic)).toBeTrue();
	});

	test("only the most recently published 500 topics keep a history", async () => {
		const first = unique();
		await publishEvent(first, 0);
		for (let index = 0; index < 500; index++) await publishEvent(unique(), index);
		expect(await keptHistory(first)).toBeFalse();
		const last = unique();
		await publishEvent(last, 1);
		expect(await keptHistory(last)).toBeTrue();
	});
});
