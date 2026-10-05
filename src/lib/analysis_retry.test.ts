import { describe, expect, test } from "bun:test";

import { analysisRetryDelayMs, describeAnalysisError, isRetryableAnalysisError } from "./analysis_retry";

describe("analysis stream retry policy", () => {
	test("retries transient gateway and provider failures", () => {
		expect(isRetryableAnalysisError({ code: "server_error" })).toBeTrue();
		expect(isRetryableAnalysisError({ error: { code: "gateway_timeout" } })).toBeTrue();
		expect(isRetryableAnalysisError({ status: 503 })).toBeTrue();
		expect(isRetryableAnalysisError({ statusCode: "429" })).toBeTrue();
		expect(isRetryableAnalysisError(new TypeError("fetch failed"))).toBeTrue();
		expect(isRetryableAnalysisError(new Error("An error occurred while processing your request."))).toBeTrue();
	});

	test("does not retry permanent request or authentication failures", () => {
		expect(isRetryableAnalysisError({ status: 400, code: "invalid_request_error" })).toBeFalse();
		expect(isRetryableAnalysisError({ status: 401, code: "invalid_api_key" })).toBeFalse();
		expect(isRetryableAnalysisError({ status: 422, code: "invalid_schema" })).toBeFalse();
	});

	test("uses capped exponential backoff with deterministic jitter", () => {
		expect(analysisRetryDelayMs(1, () => 0)).toBe(800);
		expect(analysisRetryDelayMs(2, () => 0.5)).toBe(2_000);
		expect(analysisRetryDelayMs(99, () => 1)).toBe(36_000);
	});

	test("limits persisted diagnostic text", () => {
		expect(describeAnalysisError(new Error("  gateway failed  "))).toBe("gateway failed");
		expect(describeAnalysisError(new Error("x".repeat(3_000)))).toHaveLength(2_000);
	});
});
