import { describe, expect, test } from "bun:test";

import { ProviderSubmissionRejectedError } from "../submission_contracts";
import {
	googleSafeBrowsingReportUrl,
	shouldBlockGoogleRecaptchaScript,
	submitGoogleSafeBrowsingForm,
	type GoogleSafeBrowsingSubmissionStatus,
} from "./submission";

describe("Google Safe Browsing provider helpers", () => {
	test("builds a canonical report URL without interpolating the target into the host", () => {
		const reportUrl = new URL(googleSafeBrowsingReportUrl("https://phishing.example/a?next=https://trusted.example/"));

		expect(reportUrl.origin).toBe("https://safebrowsing.google.com");
		expect(reportUrl.pathname).toBe("/safebrowsing/report_phish/");
		expect(reportUrl.searchParams.get("hl")).toBe("de");
		expect(reportUrl.searchParams.get("url")).toBe("https://phishing.example/a?next=https://trusted.example/");
	});

	test("blocks only reCAPTCHA scripts that would replace a solved token", () => {
		expect(shouldBlockGoogleRecaptchaScript("https://www.google.com/recaptcha/api.js?render=key")).toBe(true);
		expect(shouldBlockGoogleRecaptchaScript("https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js")).toBe(true);
		expect(shouldBlockGoogleRecaptchaScript("https://safebrowsing.google.com/assets/form.js")).toBe(false);
		expect(shouldBlockGoogleRecaptchaScript("https://www.google.com/recaptcha/api/siteverify")).toBe(false);
	});

	test("retries one explicit form failure inside a marked browser run and then accepts success", async () => {
		const statuses: GoogleSafeBrowsingSubmissionStatus[] = [
			{ success: false, failure: true, text: "Try again", html: "<failure />" },
			{ success: true, failure: false, text: "Submitted", html: "<success />" },
		];
		let submissions = 0;
		const pauses: number[] = [];
		const result = await submitGoogleSafeBrowsingForm({
			pressSubmit: async () => {
				submissions += 1;
			},
			readStatus: async () => statuses.shift()!,
			pause: async (milliseconds) => {
				pauses.push(milliseconds);
			},
		});
		expect(result.text).toBe("Submitted");
		expect(submissions).toBe(2);
		expect(pauses).toEqual([3_000]);
	});

	test("turns only a final explicit provider failure into provider-rejected", async () => {
		await expect(submitGoogleSafeBrowsingForm({
			pressSubmit: async () => undefined,
			readStatus: async () => ({ success: false, failure: true, text: "Provider declined", html: "<failure />" }),
			pause: async () => undefined,
		})).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);

		await expect(submitGoogleSafeBrowsingForm({
			pressSubmit: async () => undefined,
			readStatus: async () => ({ success: false, failure: false, text: "", html: "<unknown />" }),
			pause: async () => undefined,
		})).rejects.toThrow("submission status is unknown");
	});
});
