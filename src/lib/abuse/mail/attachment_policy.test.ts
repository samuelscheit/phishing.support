import { describe, expect, test } from "bun:test";

import { attachmentsAsText, isAttachmentRefusal, refusesAttachedFiles } from "./attachment_policy";

describe("isAttachmentRefusal", () => {
	test("a server refusing the attachment, its extension or its file type", () => {
		for (const diagnostic of [
			"host mail.hostzealot.com[5.149.249.39] said: 550 Attached file 'phishing-email.eml' has disallowed extension (in reply to end of DATA command)",
			"552 5.7.0 Attachment phishing-email.eml not allowed by policy",
			"550 5.7.1 Message rejected: file type .eml is prohibited",
			"554 5.7.1 Blocked attachment type: message/rfc822",
			"550 Messages with attachments of this extension are not accepted",
		]) expect(isAttachmentRefusal(diagnostic)).toBe(true);
	});

	test("a refusal of the mailbox, the sender or the content as a whole is not", () => {
		for (const diagnostic of [
			"550 5.1.1 <abuse@x.example>: Recipient address rejected: User unknown in virtual mailbox table",
			"552 5.2.2 Mailbox full",
			"554 5.7.1 [HM08] Message rejected due to local policy",
			"550 5.7.1 Message contains spam; attached you will find our policy",
			"451 4.7.1 Greylisted, please try again later",
		]) expect(isAttachmentRefusal(diagnostic)).toBe(false);
	});
});

describe("refusesAttachedMessages", () => {
	test("names the listed domains and their subdomains only", () => {
		expect(refusesAttachedFiles("abuse@hostzealot.com")).toBe(true);
		expect(refusesAttachedFiles("noc@mail.hostzealot.com")).toBe(true);
		expect(refusesAttachedFiles("abuse@hostzealot.com.example")).toBe(false);
		expect(refusesAttachedFiles("abuse@nothostzealot.com")).toBe(false);
	});
});

describe("attachmentsAsText", () => {
	test("turns attached messages and JSON files into text files and leaves everything else", () => {
		const content = Buffer.from("Subject: lure\r\n\r\nbody");
		expect(attachmentsAsText([
			{ filename: "phishing-email.eml", mimeType: "message/rfc822", content },
			{ filename: "forwarded.EML", mimeType: "application/octet-stream", content },
			{ filename: "xarf.json", mimeType: "application/json", content },
			{ filename: "report.JSON", mimeType: "application/octet-stream", content },
			{ filename: "website.png", mimeType: "image/png", content },
		])).toEqual([
			{ filename: "phishing-email.eml.txt", mimeType: "text/plain", content },
			{ filename: "forwarded.EML.txt", mimeType: "text/plain", content },
			{ filename: "xarf.json.txt", mimeType: "text/plain", content },
			{ filename: "report.JSON.txt", mimeType: "text/plain", content },
			{ filename: "website.png", mimeType: "image/png", content },
		]);
	});
});
