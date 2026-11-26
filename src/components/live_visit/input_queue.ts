import type { LiveInput } from "@/lib/site_visit/live_input";

/**
 * A driver's inputs on their way to the page: gathered for a moment, sent
 * in order with one request in flight, at most `MAX_BATCH` per request.
 * Pointer moves waiting together become their last one and wheel turns
 * their sum, so a fast hand never floods the visit. While the browser is
 * not the driver's yet (the agent finishes its action) inputs wait; a
 * request the visit refuses for that reason, or for too many inputs, is
 * sent again later. A lost turn (403) or a visit that is over (404) drops
 * everything waiting.
 */

export type PostResult = { ok: true } | { ok: false; status: number; error: string };

/** The request limit of the visit's input endpoint. */
export const MAX_BATCH = 60;

export type InputQueueOptions = {
	post: (inputs: LiveInput[]) => Promise<PostResult>;
	/** The turn is gone (taken back or expired) or the visit ended. */
	onLost: (error: string) => void;
	/** A batch the visit refused for good, or a request that failed. */
	onError: (error: string) => void;
	/** How long inputs gather before they are sent. */
	flushMs?: number;
	/** How long a batch waits before it is sent again while the agent finishes its action. */
	retryMs?: number;
	/** How long a batch waits after the visit said too many inputs. */
	rateLimitMs?: number;
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

export class InputQueue {
	readonly #options: Required<InputQueueOptions>;
	#pending: LiveInput[] = [];
	#inFlight = false;
	#ready = false;
	#cancel?: () => void;
	/** Bumped by `clear`: answers to requests sent before are ignored. */
	#generation = 0;

	constructor(options: InputQueueOptions) {
		this.#options = { flushMs: 30, retryMs: 400, rateLimitMs: 1_000, schedule: defaultSchedule, ...options };
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
		this.#later(this.#options.flushMs);
	}

	/** Whether the browser is the driver's now: inputs are sent only then. */
	setReady(ready: boolean): void {
		if (this.#ready === ready) return;
		this.#ready = ready;
		if (ready && this.#pending.length) this.#later(0);
	}

	/** Drop everything waiting; a request in flight finishes unheard. */
	clear(): void {
		this.#generation += 1;
		this.#pending = [];
		this.#inFlight = false;
		this.#cancel?.();
		this.#cancel = undefined;
	}

	#later(ms: number): void {
		if (this.#cancel || this.#inFlight) return;
		this.#cancel = this.#options.schedule(() => {
			this.#cancel = undefined;
			void this.#flush();
		}, ms);
	}

	async #flush(): Promise<void> {
		if (this.#inFlight || !this.#ready || !this.#pending.length) return;
		const generation = this.#generation;
		const batch = this.#pending.splice(0, MAX_BATCH);
		this.#inFlight = true;
		const result = await this.#options.post(batch).catch((error: unknown): PostResult => ({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }));
		if (generation !== this.#generation) return;
		this.#inFlight = false;
		if (result.ok) {
			if (this.#pending.length) this.#later(this.#options.flushMs);
			return;
		}
		if (result.status === 409 || result.status === 429) {
			this.#pending.unshift(...batch);
			this.#later(result.status === 409 ? this.#options.retryMs : this.#options.rateLimitMs);
			return;
		}
		if (result.status === 403 || result.status === 404) {
			this.clear();
			this.#options.onLost(result.error);
			return;
		}
		this.#options.onError(result.error);
		if (this.#pending.length) this.#later(this.#options.flushMs);
	}
}
