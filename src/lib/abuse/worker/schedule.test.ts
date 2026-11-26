import { describe, expect, test } from "bun:test";

import { DAY_MS, HOUR_MS, MINUTE_MS } from "../../util/date_time";
import { nextReceiptLookupDelayMs, RECEIPT_LOOKUPS_MS } from "./schedule";

describe("receipt lookups after an ambiguous submission", () => {
	test("look early and often in the first half hour, when a provider lists a stored report late", () => {
		// Cloudflare report 8bb11a971b4aee08 was missing from its list 1 and 5 minutes after its HTTP 504 and listed after 30.
		expect(RECEIPT_LOOKUPS_MS).toEqual([MINUTE_MS, 3 * MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS, DAY_MS]);
	});

	test("each next lookup is measured from the submission, not from the last lookup", () => {
		expect(nextReceiptLookupDelayMs(0)).toBe(MINUTE_MS);
		expect(nextReceiptLookupDelayMs(-5_000)).toBe(MINUTE_MS);
		// A lookup that ran a little late still keeps the schedule.
		expect(nextReceiptLookupDelayMs(MINUTE_MS + 10_000)).toBe(2 * MINUTE_MS - 10_000);
		expect(nextReceiptLookupDelayMs(3 * MINUTE_MS)).toBe(2 * MINUTE_MS);
		expect(nextReceiptLookupDelayMs(5 * MINUTE_MS + 1)).toBe(10 * MINUTE_MS - 1);
		expect(nextReceiptLookupDelayMs(16 * MINUTE_MS)).toBe(14 * MINUTE_MS);
		expect(nextReceiptLookupDelayMs(3 * HOUR_MS)).toBe(21 * HOUR_MS);
	});

	test("ends with the day-later lookup", () => {
		expect(nextReceiptLookupDelayMs(DAY_MS)).toBeUndefined();
		expect(nextReceiptLookupDelayMs(2 * DAY_MS)).toBeUndefined();
	});
});
