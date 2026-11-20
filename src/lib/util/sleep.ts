/** Wait `ms` milliseconds; an aborted signal ends the wait early (it resolves, it never rejects). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

/** An injectable `sleep`, so tests and callers with their own clock can replace the wait. */
export type Sleep = (ms: number) => Promise<void>;
