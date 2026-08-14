import { describe, expect, test } from "bun:test";

import { emailSubmissionDedupeKey } from "./email";

describe("emailSubmissionDedupeKey", () => {
	test("deduplicates an exact source message without collapsing unrelated mail from the same sender", () => {
		const first = [
			"From: sender@example.test",
			"Subject: First phishing lure",
			"",
			"Open https://phish.example.test/first",
		].join("\r\n");
		const second = [
			"From: sender@example.test",
			"Subject: Second phishing lure",
			"",
			"Open https://phish.example.test/second",
		].join("\r\n");

		expect(emailSubmissionDedupeKey(first)).toMatch(/^email:[a-f0-9]{64}$/);
		expect(emailSubmissionDedupeKey(first)).toBe(emailSubmissionDedupeKey(first));
		expect(emailSubmissionDedupeKey(second)).not.toBe(emailSubmissionDedupeKey(first));
	});
});
