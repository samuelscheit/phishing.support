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
const emitterKey = "__event_transport_emitter";
const globalEmitter = globalThis as typeof globalThis & {
	[emitterKey]?: EventEmitter;
};

const emitter = globalEmitter[emitterKey] ?? new EventEmitter();
globalEmitter[emitterKey] = emitter;
const eventHistory = new Map<string, Array<unknown>>();

export async function publishEvent(topic: string, data: unknown) {
	// Keep a bounded history per topic so late subscribers can catch up.
	const history = eventHistory.get(topic) ?? [];
	history.push(data);
	if (history.length > MAX_EVENT_HISTORY) {
		history.splice(0, history.length - MAX_EVENT_HISTORY);
	}
	eventHistory.set(topic, history);
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

	const history = eventHistory.get(topic);
	if (history?.length) {
		for (const entry of history) {
			queue.push(entry);
		}
	}

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
