import { describe, expect, test } from "bun:test";

import { TRYLEVO_MAIL } from "../../mail/trylevo_mail.fixtures";
import { cloudflareDecision } from "./decision";

describe("cloudflareDecision", () => {
	test("its response that restricted access is an action, with its own sentence", () => {
		expect(cloudflareDecision({ text: TRYLEVO_MAIL.cloudflareRestricted })).toEqual({ outcome: "action_taken", label: "Access restricted", sentence: "We have restricted access to the reported URL(s)." });
	});

	test("content it could not see closes the report, whatever else the mail says", () => {
		expect(cloudflareDecision({ text: TRYLEVO_MAIL.cloudflareNotVisible })).toEqual({
			outcome: "declined",
			label: "Declined: content not visible",
			sentence: "The reported content is no longer visible at the URLs included in your complaint.",
		});
	});

	test("a response that only forwarded the report is received, the confirmation decides nothing", () => {
		expect(cloudflareDecision({ text: "Hello,\n\nYour abuse report has been forwarded to the website owner.\n\nWe have also forwarded this report to the relevant hosting provider." })).toEqual({
			outcome: "received",
			label: "Forwarded to the host",
			sentence: "Your abuse report has been forwarded to the website owner.",
		});
		expect(cloudflareDecision({ text: TRYLEVO_MAIL.cloudflareConfirmation })).toBeUndefined();
	});

	test("its API states: denied with its reason, accepted, and states that decide nothing", () => {
		expect(cloudflareDecision({ state: "denied", detail: "content_removed" })).toEqual({ outcome: "declined", label: "Declined: content not visible" });
		expect(cloudflareDecision({ state: "denied" })).toEqual({ outcome: "declined", label: "Declined" });
		expect(cloudflareDecision({ state: "accepted" })).toEqual({ outcome: "received", label: "Accepted" });
		expect(cloudflareDecision({ state: "submitted" })).toBeUndefined();
		expect(cloudflareDecision({})).toBeUndefined();
	});
});
