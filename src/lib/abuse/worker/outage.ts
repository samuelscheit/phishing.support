/** Pauses after consecutive outages: 30 s, 1 min, 2 min, 5 min, then 15 min each. */
export const OUTAGE_BACKOFF_MS: readonly number[] = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];

/**
 * A shared pause for work that depends on one service: after an outage no
 * new work starts until the pause ends, each further outage pausing longer,
 * and one success ends the pause and starts the backoff over. Outages that
 * arrive while a pause runs (work started before it) extend nothing: one
 * outage seen by several workers at once is one step of the backoff.
 */
export class OutageBackoff {
	#step = 0;
	#pausedUntil = 0;

	constructor(private readonly delaysMs: readonly number[] = OUTAGE_BACKOFF_MS, private readonly now: () => number = Date.now) {
		if (delaysMs.length === 0) throw new RangeError("OutageBackoff needs at least one delay");
	}

	/** How long new work must still wait; 0 when it may start. */
	remainingMs(): number {
		return Math.max(0, this.#pausedUntil - this.now());
	}

	/** Record an outage; returns the pause now in force. */
	recordOutage(): number {
		if (this.remainingMs() > 0) return this.remainingMs();
		const delayMs = this.delaysMs[Math.min(this.#step, this.delaysMs.length - 1)]!;
		this.#step += 1;
		this.#pausedUntil = this.now() + delayMs;
		return delayMs;
	}

	/** The service works again: lift any pause and start the backoff over. */
	recordSuccess(): void {
		this.#step = 0;
		this.#pausedUntil = 0;
	}
}
