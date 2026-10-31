import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../../db/entities";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { capturedKitFacts } from "./kit_facts";

/** The fields the classifier cited on herstel-google.com (production submission 374668807228100627). */
const HERSTEL_FIELDS = [
	{ ref: "f1", control: "input[type=text]", id: "email", name: "username", label: "Email or phone" },
	{ ref: "f2", control: "input[type=text]", id: "captcha", name: "username", label: "Type the text you hear or see" },
	{ ref: "f3", control: "input[type=password]", id: "password", name: "password", label: "Enter your password" },
	{ ref: "f4", control: "input[type=tel]", id: "phone", name: "phone", label: "Phone number" },
	{ ref: "f5", control: "input[type=text]", id: "otp", name: "otp", label: "Enter 6-digit code" },
	{ ref: "f6", control: "input[type=text]", id: "sec-code", name: "otp" },
	{ ref: "f8", control: "input[type=text]", id: "authenticator-code", name: "otp" },
	{ ref: "f9", control: "input[type=text]", id: "backup-code", name: "otp" },
	{ ref: "f10", control: "input[type=email]", id: "recovery-email-input", name: "recoveryEmail" },
];

describe("captured kit facts", () => {
	useTemporaryDatabase();
	const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
	beforeEach(() => {
		process.env.ABUSE_TRACKING_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-bytes-long";
	});
	afterAll(() => {
		if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
		else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
	});

	test("categorizes cited fields and lists exfiltration backends found by the probe", async () => {
		const submissionId = 430000000000000001n;
		await SubmissionsEntity.create({
			id: submissionId,
			kind: "website",
			data: { kind: "website", website: {
				url: "https://herstel.example.com/",
				siteAssessments: [
					{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign in with your\nGoogle Account.", collectionFields: HERSTEL_FIELDS },
					{ hopIndex: 1, finding: "benign", collectionFields: [{ ref: "f1", control: "input[type=text]", name: "card-number" }] },
				],
				backendProbe: { status: "completed", backendCount: 1, updatedAt: "2026-10-30T00:00:00.000Z" },
			} },
			dedupeKey: "website-herstel.example.com",
			status: "reported",
			source: "https://herstel.example.com/",
		});
		for (const [target, idempotencyKey] of [["herstel.example.com", undefined], ["collector.example.net", "exfil:430000000000000001:abc"]] as const) {
			const request = await validateAbuseReportRequest({
				targets: [target],
				allegationCategory: "phishing",
				description: "Confirmed credential phishing.",
				...(idempotencyKey ? { idempotencyKey } : {}),
			});
			await AbuseRepository.createReport({ request, reporter: {}, submissionId });
		}

		expect(await capturedKitFacts(submissionId)).toEqual({
			phishingBasis: "credential_theft",
			evidenceQuote: "Sign in with your Google Account.",
			collects: ["sign-in email or phone", "password", "one-time 2FA codes", "authenticator codes", "backup codes", "recovery email", "phone number"],
			exfiltrationProbed: true,
			exfiltrationTargets: ["collector.example.net"],
		});
	});

	test("returns no claims for a submission without a phishing assessment", async () => {
		const submissionId = 430000000000000002n;
		await SubmissionsEntity.create({
			id: submissionId,
			kind: "website",
			data: { kind: "website", website: { url: "https://unknown.example/" } },
			dedupeKey: "website-unknown.example",
			status: "reported",
			source: "https://unknown.example/",
		});
		expect(await capturedKitFacts(submissionId)).toEqual({ collects: [], exfiltrationProbed: false, exfiltrationTargets: [] });
	});
});
