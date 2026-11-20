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
