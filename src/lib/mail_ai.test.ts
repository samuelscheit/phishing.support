import { expect, test } from "bun:test";

import { cleanPrivateInformation, parseMail } from "./mail_ai";

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
