import { describe, expect, test } from "bun:test";

import { discoverExfiltrationBackends, matchedCanaries } from "./analysis";
import type { ExfiltrationCanaries } from "./types";

const canaries: ExfiltrationCanaries = {
	marker: "psprobe_deadbeef",
	email: "audit+psprobe_deadbeef@example.com",
	password: "A9!psprobe_deadbeef!qZ",
	phone: "+15551234567",
	cardNumber: "4242424242424242",
	oneTimeCode: "123456",
};

describe("exfiltration traffic analysis", () => {
	test("matches raw, URL-encoded, and base64 probe values", () => {
		expect(matchedCanaries({ timestamp: "now", method: "POST", url: "https://api.example/x", postData: `email=${encodeURIComponent(canaries.email)}` }, canaries)).toContain("email");
		expect(matchedCanaries({ timestamp: "now", method: "POST", url: "https://api.example/x", postData: Buffer.from(canaries.password).toString("base64") }, canaries)).toContain("password");
	});

	test("finds Telegram, Discord, and attacker domains but ignores same-host and unrelated traffic", () => {
		const requests = [
			{ timestamp: "now", method: "POST", url: "https://api.telegram.org/bot123456:ABC_xyz/sendMessage", postData: JSON.stringify({ chat_id: "-99", text: canaries.email }) },
			{ timestamp: "now", method: "POST", url: "https://discord.com/api/webhooks/987654/token-value", postData: JSON.stringify({ content: canaries.password }) },
			{ timestamp: "now", method: "POST", url: "https://api.collector.example/submit", postData: `phone=${encodeURIComponent(canaries.phone)}` },
			{ timestamp: "now", method: "POST", url: "https://phish.example/local", postData: canaries.password },
			{ timestamp: "now", method: "GET", url: "https://fonts.example/font.woff2" },
		];
		const result = discoverExfiltrationBackends({ requests, canaries, pageUrl: "https://phish.example/login" });
		expect(result.map((item) => item.kind)).toEqual(["telegram_bot", "discord_webhook", "domain"]);
		expect(result[0]?.telegram).toMatchObject({ token: "123456:ABC_xyz", chatId: "-99" });
		expect(result[1]?.discord).toMatchObject({ webhookId: "987654", token: "token-value" });
		expect(result[2]?.hostname).toBe("api.collector.example");
	});

	test("does not infer a backend from timing alone when no canary was transmitted", () => {
		const result = discoverExfiltrationBackends({
			pageUrl: "https://phish.example/",
			canaries,
			requests: [{ timestamp: "now", method: "POST", url: "https://api.telegram.org/bot123:x/sendMessage", postData: "chat_id=1&text=hello" }],
		});
		expect(result).toEqual([]);
	});
});
