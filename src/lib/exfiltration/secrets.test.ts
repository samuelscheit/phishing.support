import { describe, expect, test } from "bun:test";

import { redactBackendSecrets, withoutBackendSecrets } from "./secrets";

const SECRET = "AAFHrVmN8m2yNpuIZlbh1lURlS1PBB-Gx44Ye";
const DISCORD = "kX9_aB3-cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5aB6cD7eF8gH9iJ0kL1mN2oP3q";

describe("redactBackendSecrets", () => {
	test("keeps a Telegram bot id and hides its secret in an endpoint", () => {
		expect(redactBackendSecrets(`https://api.telegram.org/bot9209995430:${SECRET}/sendMessage`))
			.toBe("https://api.telegram.org/bot9209995430:[redacted]/sendMessage");
	});

	test("finds a token in prose, TOON, CSV and a percent-encoded URL", () => {
		expect(redactBackendSecrets(`sent to https://api.telegram.org/bot9209995430:${SECRET}/sendMessage (POST).`)).not.toContain(SECRET);
		expect(redactBackendSecrets(`  - url: "https://api.telegram.org/bot1:x"\n  "https://api.telegram.org/bot9209995430:${SECRET}/sendMessage",POST`)).not.toContain(SECRET);
		expect(redactBackendSecrets(`https://example.invalid/?u=https%3A%2F%2Fapi.telegram.org%2Fbot9209995430%3A${SECRET}%2FsendMessage`))
			.toBe("https://example.invalid/?u=https%3A%2F%2Fapi.telegram.org%2Fbot9209995430%3A[redacted]%2FsendMessage");
		expect(redactBackendSecrets(`telegram-token:9209995430:${SECRET}`)).toBe("telegram-token:9209995430:[redacted]");
	});

	test("hides every token of a text", () => {
		const text = `a 9209995430:${SECRET} b 123456789:${SECRET.toLowerCase()}`;
		expect(redactBackendSecrets(text)).toBe("a 9209995430:[redacted] b 123456789:[redacted]");
	});

	test("hides a Discord webhook token and keeps its id", () => {
		expect(redactBackendSecrets(`https://discord.com/api/webhooks/123456789012345678/${DISCORD}`))
			.toBe("https://discord.com/api/webhooks/123456789012345678/[redacted]");
		expect(redactBackendSecrets(`https%3A%2F%2Fdiscord.com%2Fapi%2Fwebhooks%2F123456789012345678%2F${DISCORD}`))
			.toBe("https%3A%2F%2Fdiscord.com%2Fapi%2Fwebhooks%2F123456789012345678%2F[redacted]");
	});

	test("leaves text that only looks alike", () => {
		for (const text of [
			"at 12:30 on 2026-11-21T21:30:59.148Z",
			"telegram-bot:9209995430",
			"https://api.telegram.org/bot9209995430:short/sendMessage",
			"sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"[2001:db8::1]:8443",
			"https://discord.com/api/webhooks/123456789012345678",
		]) expect(redactBackendSecrets(text)).toBe(text);
	});
});

describe("withoutBackendSecrets", () => {
	test("redacts nested strings and bare token fields, keeps other values and leaves the input as it was", () => {
		const createdAt = new Date("2026-11-21T21:30:59.148Z");
		const input = {
			id: 382643803883835605n,
			createdAt,
			data: { website: { visit: { dataSent: [{ url: `https://api.telegram.org/bot9209995430:${SECRET}/sendMessage`, fields: ["password"], sameSite: false }] } } },
			backends: [{ discord: { webhookId: "123456789012345678", token: DISCORD }, telegram: { token: `9209995430:${SECRET}`, botId: "9209995430" } }],
			usage: { token: "", count: 3, ok: true, none: null },
		};
		const output = withoutBackendSecrets(input);
		expect(output.id).toBe(382643803883835605n);
		expect(output.createdAt).toBe(createdAt);
		expect(output.data.website.visit.dataSent[0]!.url).toBe("https://api.telegram.org/bot9209995430:[redacted]/sendMessage");
		expect(output.data.website.visit.dataSent[0]!.fields).toEqual(["password"]);
		expect(output.backends[0]!.discord).toEqual({ webhookId: "123456789012345678", token: "[redacted]" });
		expect(output.backends[0]!.telegram).toEqual({ token: "9209995430:[redacted]", botId: "9209995430" });
		expect(output.usage).toEqual({ token: "", count: 3, ok: true, none: null });
		expect(JSON.stringify(output, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toMatch(new RegExp(`${SECRET}|${DISCORD}`));
		expect(input.data.website.visit.dataSent[0]!.url).toContain(SECRET);
	});
});
