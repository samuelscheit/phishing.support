import { describe, expect, test } from "bun:test";

import { resolveServiceAccountTarget } from "./service_account";

describe("service account abuse routing", () => {
	test("routes Telegram bots only to Telegram's abuse mailbox", () => {
		const result = resolveServiceAccountTarget({
			normalizedTarget: "telegram-bot:123456789",
			targetType: "service_account",
			observedUrls: ["https://api.telegram.org/botTOKEN/sendMessage"],
		});
		expect(result.status).toBe("resolved");
		expect(result.routes).toHaveLength(1);
		expect(result.routes[0]).toMatchObject({
			routeType: "email",
			verifiedEmail: "abuse@telegram.org",
			providerDisplayName: "Telegram Abuse",
		});
	});

	test("keeps Discord webhook evidence but requires a human-supported channel", () => {
		const result = resolveServiceAccountTarget({
			normalizedTarget: "discord-webhook:987654321",
			targetType: "service_account",
			observedUrls: ["https://discord.com/api/webhooks/987654321/token"],
		});
		expect(result.routes[0]).toMatchObject({
			providerDisplayName: "Discord Trust & Safety",
			status: "needs_human",
		});
	});
});
