import { describe, expect, test } from "bun:test";

import {
	assertSafeHeaderValue,
	classifyIncomingMessage,
	createReplyIdentity,
	createRfcMessageId,
	extractNormalizedAddresses,
	normalizeEmailAddress,
	normalizeMessageId,
	normalizeReportRecipients,
	parseMessageIdList,
	sanitizeCorrespondenceHtml,
	validateReplyDomainForIntake,
} from "./correspondence";

describe("per-report correspondence identifiers", () => {
	test("creates opaque, lowercase 128-bit reply identities without submission data", () => {
		const identities = Array.from({ length: 24 }, () => createReplyIdentity("Phishing.Support."));

		expect(new Set(identities.map((identity) => identity.replyAddress)).size).toBe(identities.length);
		for (const identity of identities) {
			expect(identity.replyToken).toMatch(/^[a-f0-9]{32}$/);
			expect(identity.replyAddress).toMatch(/^case-[a-f0-9]{32}@phishing\.support$/);
			expect(identity.replyAddress).not.toContain("268774127068778496");
		}
	});

	test("creates normalized RFC Message-IDs with no application identifier", () => {
		const messageId = createRfcMessageId("PHISHING.SUPPORT.");

		expect(messageId).toMatch(/^<report-[a-f0-9]{32}@phishing\.support>$/);
		expect(messageId).not.toContain("submission");
	});
});

describe("mailbox and header normalization", () => {
	test("normalizes display names, case differences, folded values, and recipient lists", () => {
		expect(normalizeEmailAddress('Abuse Team <CASE-ABC@Phishing.Support>')).toBe("case-abc@phishing.support");
		expect(normalizeEmailAddress("<case-abc@phishing.support")).toBeUndefined();
		expect(normalizeEmailAddress("case-abc@phishing.support>")).toBeUndefined();
		expect(
			extractNormalizedAddresses([
				'Abuse Team <CASE-ABC@Phishing.Support>,\r\n\tOther <other@example.test>',
				"case-abc@phishing.support",
			]),
		).toEqual(["case-abc@phishing.support", "other@example.test"]);
		expect(normalizeReportRecipients('Registry Abuse <ABUSE@Example.TEST>, security@example.test')).toEqual([
			"abuse@example.test",
			"security@example.test",
		]);
	});

	test("rejects control characters before generated content reaches a MIME header", () => {
		expect(() => assertSafeHeaderValue("Subject", "safe\r\nBcc: victim@example.test")).toThrow("invalid control character");
		expect(() => normalizeReportRecipients("abuse@example.test\nBcc: victim@example.test")).toThrow("invalid control character");
		expect(() => normalizeReportRecipients("Bcc: victim@example.test")).toThrow("unsupported header");
		expect(() => normalizeReportRecipients("Recipients: abuse@example.test;")).toThrow("unsupported header");
		expect(() => normalizeReportRecipients("Abuse <abuse@example.test")).toThrow("unsupported header");
		expect(() => normalizeReportRecipients("abuse@example.test cc <victim@example.test>")).toThrow("ambiguous mailbox");
		expect(() => normalizeReportRecipients("not an address")).toThrow("malformed mailbox syntax");
	});

	test("normalizes RFC identifiers and parses folded References headers", () => {
		expect(normalizeMessageId(" <Outbound-ABC@Example.TEST> ")).toBe("<outbound-abc@example.test>");
		expect(normalizeMessageId("outbound-abc@example.test")).toBe("<outbound-abc@example.test>");
		expect(normalizeMessageId("<broken example.test>")).toBeUndefined();
		expect(
			parseMessageIdList("<FIRST@Example.TEST>\r\n\t <Second@EXAMPLE.TEST> <FIRST@example.test>"),
		).toEqual(["<first@example.test>", "<second@example.test>"]);
	});

	test("requires the generated reply domain to be monitored by the intake mailbox", () => {
		expect(() => validateReplyDomainForIntake("phishing.support", "report@phishing.support")).not.toThrow();
		expect(() => validateReplyDomainForIntake("reply.phishing.support", "report@phishing.support")).toThrow("must match");
	});
});

describe("incoming correspondence presentation", () => {
	test("classifies delivery failures, automatic replies, and human replies", () => {
		expect(
			classifyIncomingMessage({
				from: "Mail Delivery Subsystem <mailer-daemon@example.test>",
				subject: "Delivery Status Notification (Failure)",
				contentType: "multipart/report; report-type=delivery-status",
			}),
		).toBe("bounce");
		expect(
			classifyIncomingMessage({
				from: "Abuse Desk <abuse@example.test>",
				subject: "Out of office",
				headers: new Map([["auto-submitted", "auto-replied"]]),
			}),
		).toBe("auto_reply");
		expect(
			classifyIncomingMessage({
				from: "Abuse Desk <abuse@example.test>",
				subject: "Case received",
			}),
		).toBe("reply");
	});

	test("removes active content, remote resources, and tracking attributes from correspondence HTML", () => {
		const sanitized = sanitizeCorrespondenceHtml(
			'<div onclick="alert(1)" style="background:url(https://tracker.example.test/pixel)"><script>alert(1)</script><img src="https://tracker.example.test/pixel"><a href="https://evil.example.test">Read reply</a><form action="https://evil.example.test"><input value="x"></form></div>',
		);

		expect(sanitized).toContain("Read reply");
		expect(sanitized).not.toContain("script");
		expect(sanitized).not.toContain("img");
		expect(sanitized).not.toContain("form");
		expect(sanitized).not.toContain("onclick");
		expect(sanitized).not.toContain("https://");
	});
});
