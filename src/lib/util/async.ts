/** A signal that aborts after `timeoutMs` or when the caller's `signal` does, whichever comes first. */
export function deadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}

/** The promise's outcome, or a rejection with `timeoutError()` after `timeoutMs`; the timer never outlives the race. The promise itself is not cancelled. */
export async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); })]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Work started now and awaited later, maybe never: its outcome is held, so a
 * rejection before anyone awaits it is never unhandled. Each call of the
 * returned function resolves with the value or rejects with the error.
 */
export function started<T>(promise: Promise<T>): () => Promise<T> {
	const outcome = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
	return async () => {
		const settled = await outcome;
		if (!settled.ok) throw settled.error;
		return settled.value;
	};
}
