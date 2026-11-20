import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";

import { extractEmlsFromIncomingMessage } from "./forwarded";

/** A mail forwarded inline (no .eml attachment) whose quoted block names its sender in German "Von:" lines. */
const forwardedInline = (vonLines: string[]) => [
	"From: Reporter <reporter@example.org>",
	"To: support@phishing.support",
	"Subject: Fwd: Ihr Paket",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Bitte prüfen.",
	"",
	"---------- Forwarded message ---------",
	...vonLines,
	"Subject: Ihr Paket wartet",
	"",
	"Zahlen Sie 1,99 EUR unter https://paket-zustellung.example/pay",
	"",
].join("\r\n");

async function forwardedSender(vonLines: string[]): Promise<string | undefined> {
	const [eml] = await extractEmlsFromIncomingMessage(await simpleParser(forwardedInline(vonLines)));
	return (await simpleParser(eml ?? "")).from?.value[0]?.address;
}

describe("a mail forwarded inline", () => {
	test("is rebuilt with the sender its 'Von:' line names", async () => {
		expect(await forwardedSender(["Von: DHL Paket <info@paket-zustellung.example>"])).toBe("info@paket-zustellung.example");
	});

	test("with repeated 'Von:' lines keeps the first sender", async () => {
		expect(await forwardedSender(["Von: DHL Paket <info@paket-zustellung.example>", "Von: other@example.net"])).toBe("info@paket-zustellung.example");
	});
});
