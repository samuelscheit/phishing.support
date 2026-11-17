import { describe, expect, test } from "bun:test";

import { asError, errorSummary, errorText, redactedErrorText } from "./error_text";

describe("errorText", () => {
	test("reads the cause out of a WebSocket ErrorEvent instead of [object ErrorEvent]", async () => {
		// The relay at capacity refuses the CDP WebSocket upgrade; puppeteer under Bun rejects with the raw event.
		const server = Bun.serve({ port: 0, fetch: () => new Response("busy", { status: 503 }) });
		try {
			const puppeteer = await import("rebrowser-puppeteer-core");
			const thrown = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${server.port}/session` }).then(() => undefined, (error: unknown) => error);
			expect(thrown instanceof Error).toBe(false);
			expect(String(thrown)).not.toContain("503");
			expect(errorText(thrown)).toBe("Unexpected server response: 503");
			const normalized = asError(thrown);
			expect(normalized).toBeInstanceOf(Error);
			expect(normalized.message).toBe("Unexpected server response: 503");
			expect(normalized.cause).toBe(thrown);
		} finally {
			server.stop(true);
		}
	});

	test("describes errors, strings, plain objects and bare events", () => {
		expect(errorText(new Error("boom"))).toBe("boom");
		expect(errorText(new TypeError(""))).toBe("TypeError");
		expect(errorText("plain")).toBe("plain");
		expect(errorText({ error: new Error("inner") })).toBe("inner");
		expect(errorText({ reason: "  aborted  " })).toBe("aborted");
		expect(errorText(new Event("error"))).toBe("Event (error)");
		expect(errorText({ code: 7 })).toBe('{"code":7}');
		expect(errorText(undefined)).toBe("undefined");
	});

	test("summarizes to one bounded line", () => {
		expect(errorSummary(new Error("a\n  b\tc"))).toBe("a b c");
		expect(errorSummary(new Error("x".repeat(600)))).toHaveLength(500);
		const error = new Error("kept");
		expect(asError(error)).toBe(error);
	});
});

describe("external error redaction", () => {
	test("removes presigned-URL signature and credential query parameters", () => {
		const redacted = redactedErrorText(new Error("fetch failed for https://storage.example.net/a.zip?X-Amz-Signature=abc123def456&X-Amz-Credential=AKIA"));
		expect(redacted).not.toContain("abc123def456");
		expect(redacted).not.toContain("AKIA");
		expect(redacted).toContain("https://storage.example.net/a.zip");
	});

	test("redacts a credential-shaped key without emitting a literal capture placeholder", () => {
		const redacted = redactedErrorText(new Error("request failed: api_key=sk-live-123456789"));
		expect(redacted).not.toContain("sk-live-123456789");
		expect(redacted).not.toContain("$1");
		expect(redacted).toContain("api_key=[redacted]");
	});

	test("redacts a bearer token", () => {
		const redacted = redactedErrorText(new Error("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"));
		expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
		expect(redacted).not.toContain("$1");
	});

	test("bounds the length of what is returned", () => {
		expect(redactedErrorText(new Error("x".repeat(5_000))).length).toBeLessThanOrEqual(2_000);
	});
});
