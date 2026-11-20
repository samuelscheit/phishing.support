import { EventEmitter } from "events";

/**
 * Analysis progress events, published and subscribed within the one server
 * process that runs both the analyses and the SSE streams.
 */
export type EventSubscriber = {
	[Symbol.asyncIterator](): AsyncIterator<unknown>;
	close(): void;
};

type EventEnvelope = {
	topic: string;
	data: unknown;
};

const MAX_EVENT_HISTORY = 500;
/** Topics whose history is kept; the least recently published ones go first. */
const MAX_TOPICS = 500;
/** How long a finished topic's history stays for a viewer that opens the stream late. */
const FINISHED_TOPIC_TTL_MS = 10 * 60_000;
const emitterKey = "__event_transport_emitter";
const globalEmitter = globalThis as typeof globalThis & {
	[emitterKey]?: EventEmitter;
};

const emitter = globalEmitter[emitterKey] ?? new EventEmitter();
globalEmitter[emitterKey] = emitter;
/** Insertion order is publication order: a topic that publishes again moves to the back. */
const eventHistory = new Map<string, { events: unknown[]; expiresAt?: number }>();

/** The event that ends a topic's stream: a finished run or a progress step that completed or failed. */
function endsTopic(data: unknown): boolean {
	const event = typeof data === "object" && data ? data as { type?: unknown; step?: unknown; progress?: unknown } : undefined;
	return event?.type === "run.completed" || event?.type === "run.failed" || event?.step === "completed" || event?.step === "failed" || event?.progress === 100;
}

export async function publishEvent(topic: string, data: unknown) {
	// Keep a bounded history per topic so late subscribers can catch up; a
	// finished topic's goes after a while, and only so many topics are kept.
	const now = Date.now();
	for (const [name, entry] of eventHistory) if (entry.expiresAt !== undefined && entry.expiresAt <= now) eventHistory.delete(name);
	const events = eventHistory.get(topic)?.events ?? [];
	events.push(data);
	if (events.length > MAX_EVENT_HISTORY) {
		events.splice(0, events.length - MAX_EVENT_HISTORY);
	}
	eventHistory.delete(topic);
	eventHistory.set(topic, { events, ...(endsTopic(data) ? { expiresAt: now + FINISHED_TOPIC_TTL_MS } : {}) });
	for (const name of eventHistory.keys()) {
		if (eventHistory.size <= MAX_TOPICS) break;
		eventHistory.delete(name);
	}
	emitter.emit("event", { topic, data } satisfies EventEnvelope);
}

export async function subscribeToEvents(topic: string): Promise<EventSubscriber> {
	const queue: Array<unknown> = [];
	let pending: ((result: IteratorResult<unknown>) => void) | null = null;

	const push = (payload: unknown) => {
		if (pending) {
			const resolve = pending;
			pending = null;
			resolve({ value: payload, done: false });
			return;
		}
		queue.push(payload);
	};

	const onEvent = (message: EventEnvelope) => {
		if (message.topic !== topic) return;
		push(message.data);
	};

	queue.push(...(eventHistory.get(topic)?.events ?? []));

	emitter.on("event", onEvent);

	return {
		[Symbol.asyncIterator]() {
			return {
				next() {
					if (queue.length > 0) {
						const value = queue.shift();
						return Promise.resolve({ value, done: false });
					}
					return new Promise<IteratorResult<unknown>>((resolve) => {
						pending = resolve;
					});
				},
			};
		},
		close() {
			emitter.off("event", onEvent);
			if (pending) {
				pending({ value: undefined, done: true });
				pending = null;
			}
		},
	};
}
