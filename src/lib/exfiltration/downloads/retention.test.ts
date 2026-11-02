import { describe, expect, test } from "bun:test";

import { DEFAULT_SAMPLE_RETENTION_DAYS, isSampleExpired, MAX_SAMPLE_RETENTION_DAYS, sampleRetentionMs } from "./retention";

const DAY = 86_400_000;

describe("sample retention window", () => {
	test("defaults to thirty days when unset or blank", () => {
		expect(sampleRetentionMs(undefined)).toBe(DEFAULT_SAMPLE_RETENTION_DAYS * DAY);
		expect(sampleRetentionMs("   ")).toBe(DEFAULT_SAMPLE_RETENTION_DAYS * DAY);
	});

	test("accepts whole days from one up to the ceiling", () => {
		expect(sampleRetentionMs("1")).toBe(DAY);
		expect(sampleRetentionMs(String(MAX_SAMPLE_RETENTION_DAYS))).toBe(MAX_SAMPLE_RETENTION_DAYS * DAY);
	});

	test("rejects zero, negatives, fractions, words, and values past the ceiling", () => {
		for (const value of ["0", "-3", "1.5", "forever", String(MAX_SAMPLE_RETENTION_DAYS + 1)]) {
			expect(() => sampleRetentionMs(value)).toThrow();
		}
	});
});

describe("sample expiry", () => {
	const storedAt = new Date("2026-11-01T00:00:00.000Z");

	test("a sample is kept through the whole window, including its final instant", () => {
		expect(isSampleExpired(storedAt, new Date(storedAt.getTime() + DAY), DAY)).toBeFalse();
	});

	test("a sample expires once the window has fully elapsed", () => {
		expect(isSampleExpired(storedAt, new Date(storedAt.getTime() + DAY + 1), DAY)).toBeTrue();
	});

	test("an unreadable timestamp is treated as expired, never kept indefinitely", () => {
		expect(isSampleExpired(new Date("not a date"), new Date(), DAY)).toBeTrue();
		expect(isSampleExpired(storedAt, new Date(Number.NaN), DAY)).toBeTrue();
	});
});
