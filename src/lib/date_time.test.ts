import { describe, expect, test } from "bun:test";

import { formatUtcDateTime } from "./date_time";

describe("formatUtcDateTime", () => {
	test("renders dates identically regardless of the runtime timezone", () => {
		const timestamp = "2026-09-11T11:54:47.000Z";

		expect(formatUtcDateTime(timestamp)).toBe("2026-09-11 11:54 UTC");
		expect(formatUtcDateTime(new Date(timestamp))).toBe("2026-09-11 11:54 UTC");
		expect(formatUtcDateTime(Date.parse(timestamp))).toBe("2026-09-11 11:54 UTC");
	});

	test("does not fabricate a timestamp for absent or invalid values", () => {
		expect(formatUtcDateTime(undefined)).toBeUndefined();
		expect(formatUtcDateTime("not a date")).toBeUndefined();
	});
});
