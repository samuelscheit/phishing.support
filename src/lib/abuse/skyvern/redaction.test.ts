import { describe, expect, test } from "bun:test";

import { redactExternalError } from "./adapter";

describe("external error redaction", () => {
	test("removes presigned-URL signature and credential query parameters", () => {
		const redacted = redactExternalError(new Error("fetch failed for https://storage.example.net/a.zip?X-Amz-Signature=abc123def456&X-Amz-Credential=AKIA"));
		expect(redacted).not.toContain("abc123def456");
		expect(redacted).not.toContain("AKIA");
		expect(redacted).toContain("https://storage.example.net/a.zip");
	});

	test("redacts a credential-shaped key without emitting a literal capture placeholder", () => {
		const redacted = redactExternalError(new Error("request failed: api_key=sk-live-123456789"));
		expect(redacted).not.toContain("sk-live-123456789");
		expect(redacted).not.toContain("$1");
		expect(redacted).toContain("api_key=[redacted]");
	});

	test("redacts a bearer token", () => {
		const redacted = redactExternalError(new Error("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"));
		expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(redacted).not.toContain("$1");
	});

	test("bounds the length of what is returned", () => {
		expect(redactExternalError(new Error("x".repeat(5_000))).length).toBeLessThanOrEqual(2_000);
	});
});
