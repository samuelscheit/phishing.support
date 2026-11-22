import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";

import { deliveryFailure, deliveryReport, type DeliveryOutcome } from "./delivery_report";
import { deliveryReportFixture, FIXTURE_MESSAGE_ID } from "./fixtures/delivery_reports/fixture";
import { inboundBodyText } from "./shared";

/** Each real report, what it says, and whether it returned our Message-ID in its text. */
const reports: Array<[name: string, outcome: DeliveryOutcome, returnsOurId: boolean]> = [
	["office365-forwarded-recipients-not-found.eml", "permanent", true],
	["icloud-postfix-rejected.eml", "permanent", true],
	["exim-permanent.eml", "permanent", true],
	["gmail-failed-permanently.eml", "permanent", true],
	["qmail-permanent.eml", "permanent", true],
	["exchange2003-recipient-not-recognized.eml", "permanent", false],
	["exchange2007-user-unknown.eml", "permanent", false],
	["office365-user-unknown.eml", "permanent", false],
	["opensmtpd-permanent.eml", "permanent", false],
	["postfix-mixed-recipients.eml", "permanent", false],
	["exim-delay-warning.eml", "temporary", false],
	["gmail-delay-warning.eml", "temporary", true],
	["outlook-delay.eml", "temporary", false],
	["postfix-temporary.eml", "temporary", true],
	["opensmtpd-delay-warning.eml", "temporary", false],
];

describe("delivery reports of real mail servers", () => {
	test.each(reports)("%s is a delivery report saying %s", async (name, outcome, returnsOurId) => {
		const parsed = await simpleParser(deliveryReportFixture(name));
		const failure = deliveryFailure(parsed);
		expect(failure).toBeDefined();
		expect(failure!.messageIds.includes(FIXTURE_MESSAGE_ID)).toBe(returnsOurId);
		// Classification reads the text as stored: whitespace flattened, HTML stripped.
		expect(deliveryReport(inboundBodyText(parsed)).outcome).toBe(outcome);
		expect(deliveryReport(parsed.text ?? "").outcome).toBe(outcome);
	});

	test("Office 365's report threads to the returned mail and names the hop that refused it", async () => {
		const parsed = await simpleParser(deliveryReportFixture("office365-forwarded-recipients-not-found.eml"));
		expect(parsed.inReplyTo).toBe(FIXTURE_MESSAGE_ID);
		expect(deliveryReport(inboundBodyText(parsed)).diagnostic).toBe(
			"smtp;550 5.4.1 Recipient address rejected: Access denied. For more information see https://aka.ms/EXOSmtpErrors [SG1PEPF000082E7.apcprd02.prod.outlook.com 2026-11-20T21:37:17.513Z 08DF465DC36FD6DA]",
		);
	});

	test.each(["google-noreply-autoresponder.eml", "bluehost-noreply-autoresponder.eml"])("%s, a no-reply autoresponder, is no delivery report", async (name) => {
		expect(deliveryFailure(await simpleParser(deliveryReportFixture(name)))).toBeUndefined();
	});
});

describe("what makes mail a delivery report", () => {
	const mail = (headers: string[], body = "Thank you for your report.") => simpleParser(Buffer.from([...headers, "", body].join("\r\n")));

	test("a person writing from the postmaster mailbox, or an out-of-office notice, is not one", async () => {
		expect(deliveryFailure(await mail(["From: Postmaster <postmaster@isp.example>", "Subject: Re: [Phishing Support] Abuse report for phish.example"]))).toBeUndefined();
		expect(deliveryFailure(await mail(["From: abuse@isp.example", "Auto-Submitted: auto-replied", "Subject: Automatic reply: [Phishing Support] Abuse report"]))).toBeUndefined();
	});

	test("the postmaster mailbox or an auto-reply with a failure subject is one", async () => {
		expect(deliveryFailure(await mail(["From: postmaster@isp.example", "Subject: Undeliverable: [Phishing Support] Abuse report"]))).toEqual({ messageIds: [] });
		expect(deliveryFailure(await mail(["From: helpdesk@isp.example", "Auto-Submitted: auto-replied", "Subject: Mail delivery failed: returning message to sender"]))).toEqual({ messageIds: [] });
	});

	test("Exim's and Exchange's markers make one whatever the sender and subject", async () => {
		expect(deliveryFailure(await mail(["From: relay@isp.example", "X-Failed-Recipients: abuse@isp.example", "Subject: Notice"]))).toBeDefined();
		expect(deliveryFailure(await mail(["From: Microsoft Outlook <MicrosoftExchange0123@isp.onmicrosoft.com>", "X-MS-Exchange-Message-Is-Ndr:", "Subject: Notice"]))).toBeDefined();
	});

	test("only our own Message-IDs bind it to a send, lowercased like the ones we generate", async () => {
		const report = await mail(["From: MAILER-DAEMON@mx.isp.example", "Subject: failure notice"], "Message-ID: <ABUSE-0AF1@Phishing.Support>\r\nIn-Reply-To: <other@isp.example>");
		expect(deliveryFailure(report)).toEqual({ messageIds: ["<abuse-0af1@phishing.support>"] });
	});
});

describe("what a delivery report says", () => {
	test("any permanently failed recipient makes it permanent: a resend would fail there again", () => {
		expect(deliveryReport("Status: 4.4.7 Action: delayed Status: 5.1.1 Action: failed").outcome).toBe("permanent");
		expect(deliveryReport("Status: 4.4.7\nAction: failed").outcome).toBe("temporary");
	});

	test("Status fields outrank the prose around them", () => {
		expect(deliveryReport("This is a permanent error. Status: 4.2.2").outcome).toBe("temporary");
		expect(deliveryReport("Warning message only. Status: 5.1.1").outcome).toBe("permanent");
	});

	test("without Status fields the MTA's own statement decides, then the codes it quotes", () => {
		expect(deliveryReport("This is a permanent error; I've given up. (#4.4.3)").outcome).toBe("permanent");
		expect(deliveryReport("THIS IS A WARNING MESSAGE ONLY. 550 5.1.1 later").outcome).toBe("temporary");
		expect(deliveryReport("host mx.isp.example said: 451 4.7.1 Greylisted").outcome).toBe("temporary");
		expect(deliveryReport("remote host said: 452 Mailbox full").outcome).toBe("temporary");
		expect(deliveryReport("remote host said: 550 No such user").outcome).toBe("permanent");
	});

	test("an IP address or an MTA version is no status code", () => {
		expect(deliveryReport("Received: from 10.4.5.6 by mx (Exim 4.94.2) id 1abc").outcome).toBe("permanent");
		expect(deliveryReport("relay 192.0.4.4.2 failed").outcome).toBe("permanent");
	});

	test("a report that says nothing is a failure: relays send us failure notices only", () => {
		expect(deliveryReport("").outcome).toBe("permanent");
		expect(deliveryReport("The recipient name is not recognized").outcome).toBe("permanent");
	});

	test("the diagnostic ends at the next field, flattened or folded, and is bounded", () => {
		expect(deliveryReport("Diagnostic-Code: smtp; 550 5.1.1 <a@isp.example>: Recipient address rejected Remote-MTA: dns; mx.isp.example").diagnostic)
			.toBe("smtp; 550 5.1.1 <a@isp.example>: Recipient address rejected");
		expect(deliveryReport("Action: failed\nDiagnostic-Code: smtp; 550 5.1.1 user\n    unknown\nLast-Attempt-Date: today").diagnostic).toBe("smtp; 550 5.1.1 user unknown");
		expect(deliveryReport(`Diagnostic-Code: ${"x".repeat(2_000)}`).diagnostic).toHaveLength(1_000);
		expect(deliveryReport("Status: 5.1.1").diagnostic).toBeUndefined();
	});
});
