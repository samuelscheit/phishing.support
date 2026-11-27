/** Gives back one slot; calling it again does nothing. */
export type SemaphoreRelease = () => void;

/**
 * A counting semaphore: at most `capacity` holders at once, the rest wait in
 * arrival order. A waiter gives up through its `AbortSignal`, which leaves
 * the queue at once and rejects with the signal's reason.
 */
export class Semaphore {
	#available: number;
	readonly #waiters: Array<() => void> = [];

	constructor(readonly capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError(`Semaphore capacity must be a positive integer, got ${capacity}`);
		this.#available = capacity;
	}

	/** Free slots right now. */
	get available(): number {
		return this.#available;
	}

	/** Callers queued for a slot. */
	get waiting(): number {
		return this.#waiters.length;
	}

	/** Take a slot, waiting for one when all are held; resolves to its release. */
	acquire(signal?: AbortSignal): Promise<SemaphoreRelease> {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (this.#available > 0) {
			this.#available -= 1;
			return Promise.resolve(this.#release());
		}
		return new Promise<SemaphoreRelease>((resolve, reject) => {
			const grant = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve(this.#release());
			};
			const onAbort = () => {
				const index = this.#waiters.indexOf(grant);
				if (index >= 0) this.#waiters.splice(index, 1);
				reject(signal!.reason);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#waiters.push(grant);
		});
	}

	/** A slot's release: it passes the slot straight to the longest waiter, else frees it. */
	#release(): SemaphoreRelease {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiters.shift();
			if (next) next();
			else this.#available += 1;
		};
	}
}
