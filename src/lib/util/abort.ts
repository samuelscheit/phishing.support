import { errorChain } from "./error_chain";

/**
 * Whether `error`, or any error in its `cause` chain, is a cancellation: an
 * aborted request (`AbortError`) or an elapsed `AbortSignal.timeout`
 * (`TimeoutError`). Such a failure says nothing about the work's target.
 */
export function isAbortError(error: unknown): boolean {
	return errorChain(error).some((entry) => entry.name === "AbortError" || entry.name === "TimeoutError");
}

/**
 * `promise`, or a rejection with the signal's reason as soon as it aborts,
 * for work that cannot be cancelled itself. A value that still arrives after
 * the abort is handed to `discard` (close the connection, cancel the session
 * it opened), so nothing it holds leaks.
 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, discard?: (late: T) => unknown): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(signal.reason);
			void promise.then((late) => discard?.(late)).catch(() => undefined);
		};
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
	});
}
