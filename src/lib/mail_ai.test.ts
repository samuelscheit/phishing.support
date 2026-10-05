import { expect, test } from "bun:test";

import { cleanPrivateInformation, parseMail } from "./mail_ai";
import type { WhoISInfo } from "./website_info";

const noOriginInfo: WhoISInfo = { ip_rdaps: [] };

test("cleanPrivateInformation redacts recipient address everywhere in attached email", async () => {
	const address = "samuel.scheit@me.com";
	const encoded = Buffer.from(address, "utf-8").toString("base64");
	const eml = [
		"From: Sender <sender@example.test>",
		`To: =?utf-8?B?${encoded}?= <${address}>`,
		"Cc: Samuel Scheit <samuel.scheit@me.com>",
		"Subject: Private recipient",
		"Content-Type: text/plain; charset=utf-8",
		"",
		`Hello ${address}`,
	].join("\r\n");
	const cleaned = cleanPrivateInformation(await parseMail(eml));
	const serialized = JSON.stringify(cleaned);

	expect(cleaned.to).toBe('"[redacted]" <[redacted]>');
	expect(cleaned.to_object?.address).toBe("[redacted]");
	expect(cleaned.to_object?.name).toBe("[redacted]");
	expect(serialized).not.toContain(address);
	expect(serialized).not.toContain(encoded);
	expect(serialized).toContain("[redacted]");
});

test("cleanPrivateInformation redacts MIME encoded recipient headers", async () => {
	const address = "private.person@example.test";
	const encoded = Buffer.from(address, "utf-8").toString("base64");
	const eml = [
		"From: Sender <sender@example.test>",
		"To: =?utf-8?B?" + encoded + "?= <" + address + ">",
		"Subject: test",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Hello " + address,
	].join("\r\n");

	const cleaned = cleanPrivateInformation(await parseMail(eml));
	const serialized = JSON.stringify(cleaned);

	expect(cleaned.to).toBe('"[redacted]" <[redacted]>');
	expect(serialized).not.toContain(address);
	expect(serialized).not.toContain(encoded);
});

test("does not treat the sender-controlled From domain as delivery infrastructure", async () => {
	let lookups = 0;
	const mail = await parseMail([
		"From: Displayed Sender <sender@example.test>",
		"To: recipient@example.test",
		"Subject: no transport trace",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Hello",
	].join("\r\n"), {
		getInfo: async () => {
			lookups += 1;
			return noOriginInfo;
		},
	});

	expect(lookups).toBe(0);
	expect(mail.headers.routing.originatingIp).toBeUndefined();
	expect(mail.headers.routing.originatingServer).toBeUndefined();
	expect(mail.whois).toBeUndefined();
});

test("looks up the SMTP origin only when a Received chain supplies one", async () => {
	const lookedUp: string[] = [];
	const mail = await parseMail([
		"Received: from mail.sender.test (mail.sender.test [198.51.100.42]) by mx.example.test with ESMTP; Thu, 11 Sep 2026 10:00:00 +0000",
		"From: Displayed Sender <sender@example.test>",
		"To: recipient@example.test",
		"Subject: traced delivery",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Hello",
	].join("\r\n"), {
		getInfo: async (target) => {
			lookedUp.push(target);
			return noOriginInfo;
		},
	});

	expect(lookedUp).toEqual(["198.51.100.42"]);
	expect(mail.headers.routing.originatingIp).toBe("198.51.100.42");
	expect(mail.headers.routing.originatingServer).toBe("mail.sender.test");
	expect(mail.whois).toEqual(noOriginInfo);
});
