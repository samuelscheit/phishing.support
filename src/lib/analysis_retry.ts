/**
 * Retry policy for model analysis requests.
 *
 * A Responses request can be accepted (HTTP 200) and then fail later while
 * its SSE body is being consumed.  The OpenAI SDK surfaces that as an async
 * iterator error, so transport-level request retries alone are insufficient.
 */

const RETRYABLE_CODES = new Set([
	"bad_gateway",
	"gateway_timeout",
	"internal_error",
	"rate_limit_exceeded",
	"server_error",
	"service_unavailable",
	"service_unavailable_error",
	"timeout",
	"timeout_error",
]);

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

type ErrorLike = {
	code?: unknown;
	status?: unknown;
	statusCode?: unknown;
	type?: unknown;
	message?: unknown;
	error?: unknown;
	cause?: unknown;
};

function asRecord(value: unknown): ErrorLike | undefined {
	return value && typeof value === "object" ? (value as ErrorLike) : undefined;
}

function asStatus(value: unknown): number | undefined {
	const status = typeof value === "number" ? value : Number(value);
	return Number.isInteger(status) ? status : undefined;
}

function errorCode(error: ErrorLike): string {
	const nested = asRecord(error.error);
	const cause = asRecord(error.cause);
	return String(error.code ?? nested?.code ?? cause?.code ?? error.type ?? nested?.type ?? cause?.type ?? "").trim().toLowerCase();
}

/** A bounded, display-safe error message for persisted retry diagnostics. */
export function describeAnalysisError(error: unknown): string {
	const message = error instanceof Error ? error.message : asRecord(error)?.message;
	const text = typeof message === "string" && message.trim() ? message.trim() : String(error);
	return text.slice(0, 2_000);
}

/**
 * Returns true only for failures where reissuing a model analysis is expected
 * to be safe and useful. Client/input/authentication failures deliberately do
 * not retry.
 */
export function isRetryableAnalysisError(error: unknown): boolean {
	const candidate = asRecord(error);
	if (!candidate) return error instanceof TypeError;

	const nested = asRecord(candidate.error);
	const cause = asRecord(candidate.cause);
	const status = asStatus(candidate.status ?? candidate.statusCode ?? nested?.status ?? nested?.statusCode ?? cause?.status ?? cause?.statusCode);
	if (status !== undefined) return RETRYABLE_STATUSES.has(status) || status >= 500;

	if (RETRYABLE_CODES.has(errorCode(candidate))) return true;

	const message = describeAnalysisError(error).toLowerCase();
	return (
		message.includes("an error occurred while processing your request") ||
		message.includes("server error") ||
		message.includes("service unavailable") ||
		message.includes("gateway timeout") ||
		message.includes("network error") ||
		message.includes("fetch failed") ||
		message.includes("socket hang up") ||
		message.includes("connection reset")
		|| message.includes("stream ended without completion")
	);
}

/** Exponential backoff with jitter, capped so a transient provider outage does not stall a report indefinitely. */
export function analysisRetryDelayMs(retryNumber: number, random: () => number = Math.random): number {
	const boundedRetry = Math.max(1, Math.floor(retryNumber));
	const exponential = Math.min(30_000, 1_000 * 2 ** (boundedRetry - 1));
	return Math.round(exponential * (0.8 + Math.min(1, Math.max(0, random())) * 0.4));
}
