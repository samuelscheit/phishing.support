import { describe, expect, test } from "bun:test";

import { enrichDiscordWebhook, enrichTelegramBot } from "./identity";
import type { ExfiltrationBackend } from "./types";

const request = { timestamp: "now", method: "POST", url: "https://example.test" };

describe("read-only shared-service identity lookups", () => {
	test("uses only Telegram getMe and retains the bot ID as a string", async () => {
		let called = "";
		const backend: ExfiltrationBackend = { kind: "telegram_bot", key: "t", endpointUrl: request.url, hostname: "api.telegram.org", method: "POST", matchedCanaries: ["email"], request, telegram: { token: "123:abcdefgh" } };
		const enriched = await enrichTelegramBot(backend, async (input, init) => {
			called = String(input);
			expect(init?.method).toBe("GET");
			return Response.json({ ok: true, result: { id: 9007199254740991, username: "collector_bot" } });
		});
		expect(new URL(called).pathname).toEndWith("/getMe");
		expect(enriched.telegram).toMatchObject({ username: "collector_bot" });
	});

	test("reads Discord webhook metadata without issuing a write", async () => {
		const backend: ExfiltrationBackend = { kind: "discord_webhook", key: "d", endpointUrl: request.url, hostname: "discord.com", method: "POST", matchedCanaries: ["password"], request, discord: { webhookId: "42", token: "opaque123" } };
		const enriched = await enrichDiscordWebhook(backend, async (input, init) => {
			expect(String(input)).toContain("/api/v10/webhooks/42/opaque123");
			expect(init?.method).toBe("GET");
			return Response.json({ guild_id: "7", channel_id: "8", name: "exfil" });
		});
		expect(enriched.discord).toMatchObject({ guildId: "7", channelId: "8", name: "exfil" });
	});
});
