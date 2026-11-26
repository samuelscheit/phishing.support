/** A timeout whose clock can be stopped and started again; its signal aborts once the time ran out. */
export type PausableTimeout = {
	readonly signal: AbortSignal;
	pause(): void;
	resume(): void;
	/** Stop it for good (its timer no longer holds the process). */
	clear(): void;
};

export function pausableTimeout(ms: number): PausableTimeout {
	const controller = new AbortController();
	let remaining = ms;
	let startedAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cleared = false;
	const run = () => {
		startedAt = Date.now();
		timer = setTimeout(() => controller.abort(new DOMException(`timed out after ${ms} ms`, "TimeoutError")), remaining);
		// Like `AbortSignal.timeout`, it never keeps the process alive on its own.
		(timer as { unref?: () => void }).unref?.();
	};
	run();
	return {
		signal: controller.signal,
		pause() {
			if (!timer) return;
			clearTimeout(timer);
			timer = undefined;
			remaining = Math.max(0, remaining - (Date.now() - startedAt));
		},
		resume() {
			if (!timer && !cleared && !controller.signal.aborted) run();
		},
		clear() {
			cleared = true;
			clearTimeout(timer);
			timer = undefined;
		},
	};
}
