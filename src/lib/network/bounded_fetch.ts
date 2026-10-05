/**
 * Bounded fetch primitives for evidence collection.  A failed third-party
 * service must never hold an analysis worker indefinitely: every attempt has
 * a real deadline (including body reads) and transient failures are retried a
 * finite number of times.
 */

/** All evidence clients use absolute string URLs, which keeps test adapters small and deterministic. */
export type FetchImplementation = (input: string, init?: RequestInit) => Promise<Response>;

export type BoundedRequestOptions = {
	fetch?: FetchImplementation;
	timeoutMs?: number;
	attempts?: number;
	retryDelayMs?: number;
	maxResponseBytes?: number;
};

export type RetryWithTimeoutOptions = Pick<BoundedRequestOptions, "timeoutMs" | "attempts" | "retryDelayMs"> & {
	label: string;
	shouldRetry?: (error: unknown) => boolean;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class RequestTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RequestTimeoutError";
	}
}

class RequestStatusError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
	) {
		super(`Request to ${new URL(url).hostname} failed with HTTP ${status}.`);
		this.name = "RequestStatusError";
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function settings(options: BoundedRequestOptions) {
	return {
		timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS),
		attempts: positiveInteger(options.attempts, DEFAULT_ATTEMPTS),
		retryDelayMs: Math.max(0, Number.isFinite(options.retryDelayMs) ? Math.floor(options.retryDelayMs!) : DEFAULT_RETRY_DELAY_MS),
		maxResponseBytes: positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
	};
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryable(error: unknown): boolean {
	if (!(error instanceof RequestStatusError)) return true;
	return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

async function withAttemptDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new RequestTimeoutError(`${label} timed out after ${timeoutMs}ms.`));
		}, timeoutMs);
	});

	try {
		// The race is intentional.  Test doubles and some broken HTTP clients can
		// ignore AbortSignal; waiting for them anyway would recreate the stuck-job
		// failure this module prevents.
		return await Promise.race([operation(controller.signal), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
	const lengthHeader = Number(response.headers.get("content-length"));
	if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
		throw new Error("Response exceeded its size limit.");
	}
	if (!response.body) return Buffer.alloc(0);

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				void reader.cancel();
				throw new Error("Response exceeded its size limit.");
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, byteLength);
}

/**
 * Fetch a JSON endpoint with a deadline that covers connection and streaming
 * body consumption.  `404` is represented as `undefined`; callers can use
 * it for RDAP's normal not-found response without treating it as an outage.
 */
export async function fetchJson<T>(url: string, init: RequestInit, options: BoundedRequestOptions = {}): Promise<T | undefined> {
	const config = settings(options);
	const fetchImplementation = options.fetch ?? fetch;
	let lastError: unknown;

	for (let attempt = 1; attempt <= config.attempts; attempt++) {
		try {
			return await withAttemptDeadline(async (signal) => {
				const response = await fetchImplementation(url, { ...init, signal });
				if (response.status === 404) return undefined;
				if (!response.ok) throw new RequestStatusError(response.status, url);
				const body = await readResponseBody(response, config.maxResponseBytes);
				try {
					return JSON.parse(body.toString("utf8")) as T;
				} catch {
					throw new Error(`Response from ${new URL(url).hostname} was not valid JSON.`);
				}
			}, config.timeoutMs, `Request to ${new URL(url).hostname}`);
		} catch (error) {
			lastError = error;
			if (attempt === config.attempts || !isRetryable(error)) break;
			if (config.retryDelayMs > 0) await sleep(config.retryDelayMs);
		}
	}

	throw lastError instanceof Error ? lastError : new Error(`Request to ${new URL(url).hostname} failed.`);
}

/** Bound arbitrary asynchronous work whose implementation can ignore cancellation. */
export function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return withAttemptDeadline(async () => operation(), timeoutMs, label);
}

/** Retry bounded non-fetch work such as the Node DNS resolver. */
export async function retryWithTimeout<T>(operation: () => Promise<T>, options: RetryWithTimeoutOptions): Promise<T> {
	const config = settings(options);
	let lastError: unknown;
	for (let attempt = 1; attempt <= config.attempts; attempt++) {
		try {
			return await withTimeout(operation, config.timeoutMs, options.label);
		} catch (error) {
			lastError = error;
			if (attempt === config.attempts || options.shouldRetry?.(error) === false) break;
			if (config.retryDelayMs > 0) await sleep(config.retryDelayMs);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(`${options.label} failed.`);
}
