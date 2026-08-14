import { describe, expect, spyOn, test } from "bun:test";

import { SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { parseMail } from "../mail_ai";
import { reportEmailPhishing } from "./reportEmailPhishing";

useTemporaryDatabase();

describe("reportEmailPhishing", () => {
	test("continues with the independent Netcraft report when SMTP draft generation fails", async () => {
		const submissionId = await SubmissionsEntity.create({
			kind: "email",
			data: { kind: "email" },
			dedupeKey: "report-email-phishing-netcraft-independent",
		});
		const rawMime = [
			"From: Phish <notice@phish.example.test>",
			"To: private.recipient@example.test",
			"Subject: Verify your account",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Open https://phish.example.test/login now.",
		].join("\r\n");
		const mail = await parseMail(rawMime);
		let receivedRawMime: string | undefined;
		let receivedArtifactId: bigint | undefined;
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		let result: Awaited<ReturnType<typeof reportEmailPhishing>>;
		try {
			result = await reportEmailPhishing({
				submissionId,
				mail,
				analysisText: "The message impersonates a trusted service and steals credentials.",
				originalEmlArtifactId: 456n,
			}, {
				reportNetcraftMail: async (params) => {
					receivedRawMime = params.rawMime;
					receivedArtifactId = params.originalEmlArtifactId;
					return {
						outcome: "submitted",
						providerReportId: 123n,
						confirmationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						finalUrl: "https://report.netcraft.com/api/v3/submission/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					};
				},
				generateReportDraft: async () => {
					throw new Error("draft service unavailable");
				},
			});
		} finally {
			consoleError.mockRestore();
		}

		expect(receivedRawMime).toBe(rawMime);
		expect(receivedArtifactId).toBe(456n);
		expect(result.netcraft).toMatchObject({ status: "fulfilled", value: { outcome: "submitted" } });
		expect(result.smtp).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "draft service unavailable" }) });
	});
});
