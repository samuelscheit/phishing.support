import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { SubmissionRetryError, emailSubmissionDedupeKey, retryFailedEmailAnalysis } from "./email";

useTemporaryDatabase();

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

	test("claims a failed submission only through an atomic state transition", async () => {
		const id = await SubmissionsEntity.create({
			id: 1n,
			kind: "email",
			data: { kind: "email" },
			dedupeKey: "retry-claim",
			status: "failed",
		});

		await expect(retryFailedEmailAnalysis(id)).rejects.toBeInstanceOf(SubmissionRetryError);
		// The missing source artifact is rejected before claiming, so this test
		// also verifies a failed row is not made unretryable by validation.
		expect((await SubmissionsEntity.get(id))?.status).toBe("failed");
		expect(await SubmissionsEntity.transitionStatus(id, "failed", "queued")).toBeTrue();
		expect(await SubmissionsEntity.transitionStatus(id, "failed", "queued")).toBeFalse();
	});
});
