/**
 * Small cancellation primitives shared by provider adapters. Abort signals do
 * not magically cancel third-party promises, so callers must also provide an
 * `onAbort` cleanup hook (usually closing a browser or transport).
 */
export class OperationCanceledError extends Error {
	constructor(message = "The operation was canceled.") {
		super(message);
		this.name = "OperationCanceledError";
	}
}

export function throwIfOperationCanceled(signal: AbortSignal | undefined, message?: string): void {
	if (signal?.aborted) throw new OperationCanceledError(message);
}

export async function raceAbort<T>(
	operation: Promise<T>,
	signal: AbortSignal | undefined,
	onAbort?: () => void,
	message?: string,
): Promise<T> {
	if (!signal) return operation;
	throwIfOperationCanceled(signal, message);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onCanceled = () => {
			if (settled) return;
			settled = true;
			try {
				onAbort?.();
			} catch {
				// Cleanup is best effort; cancellation must still settle the caller.
			}
			cleanup();
			reject(new OperationCanceledError(message));
		};
		const cleanup = () => signal.removeEventListener("abort", onCanceled);
		signal.addEventListener("abort", onCanceled, { once: true });
		operation.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}
