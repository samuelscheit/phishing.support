import type { LiveInput } from "@/lib/site_visit/live_input";

/**
 * A driver's inputs on their way to the page, over the visit's socket. A
 * click, a key or text goes out at once (with whatever waits before it);
 * pointer moves and wheel turns gather for one frame, moves becoming their
 * last one and wheel turns their sum, so a fast hand never floods the visit.
 * Inputs wait while the browser is not the driver's yet or the socket is
 * down, and are dropped with `clear` once the turn is gone.
 */

/** Inputs per message, as the visit takes them. */
export const MAX_BATCH = 60;
/** How long moves and wheel turns gather: one frame. */
export const GATHER_MS = 16;

export type InputQueueOptions = {
	/** Send a batch now; false when it could not be sent (it waits for the next chance). */
	send: (inputs: LiveInput[]) => boolean;
	schedule?: (run: () => void, ms: number) => () => void;
};

const defaultSchedule = (run: () => void, ms: number) => {
	const timer = setTimeout(run, ms);
	return () => clearTimeout(timer);
};

/** Whether `next` can take the place of (or add up with) `last` while both wait. */
function merged(last: LiveInput, next: LiveInput): LiveInput | undefined {
	if (last.type === "pointer" && next.type === "pointer" && last.phase === "move" && next.phase === "move" && last.button === next.button) return next;
	if (last.type === "wheel" && next.type === "wheel") return { ...next, deltaX: last.deltaX + next.deltaX, deltaY: last.deltaY + next.deltaY };
	return undefined;
}

const gathers = (input: LiveInput) => (input.type === "pointer" && input.phase === "move") || input.type === "wheel";

export class InputQueue {
	readonly #send: InputQueueOptions["send"];
	readonly #schedule: NonNullable<InputQueueOptions["schedule"]>;
	#pending: LiveInput[] = [];
	#ready = false;
	#cancel?: () => void;

	constructor(options: InputQueueOptions) {
		this.#send = options.send;
		this.#schedule = options.schedule ?? defaultSchedule;
	}

	get pending(): readonly LiveInput[] {
		return this.#pending;
	}

	push(...inputs: LiveInput[]): void {
		for (const input of inputs) {
			const last = this.#pending.at(-1);
			const combined = last && merged(last, input);
			if (combined) this.#pending[this.#pending.length - 1] = combined;
			else this.#pending.push(input);
		}
		if (inputs.some((input) => !gathers(input))) this.flush();
		else this.#cancel ??= this.#schedule(() => {
			this.#cancel = undefined;
			this.flush();
		}, GATHER_MS);
	}

	/** Whether inputs can go now: the browser is the driver's and the socket is up. */
	setReady(ready: boolean): void {
		this.#ready = ready;
		if (ready) this.flush();
	}

	/** Send everything waiting, if it can go. */
	flush(): void {
		this.#cancel?.();
		this.#cancel = undefined;
		while (this.#ready && this.#pending.length) {
			const batch = this.#pending.slice(0, MAX_BATCH);
			if (!this.#send(batch)) return;
			this.#pending.splice(0, batch.length);
		}
	}

	/** Drop everything waiting. */
	clear(): void {
		this.#pending = [];
		this.#cancel?.();
		this.#cancel = undefined;
	}
}
