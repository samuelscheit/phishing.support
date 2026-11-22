import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { discordUserAgent } from "../../../network/service_identity";

import { SubmissionsEntity } from "../../../db/entities/submissions";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { reportExfiltrationBackend } from "../../../exfiltration/reporting";
import type { ExfiltrationBackend } from "../../../exfiltration/types";
import { AbuseRepository } from "../../repository";
import { resolveAbuseTarget } from "../../resolver";
import { executeProviderSubmission } from "../submission_execution";
import type { ProviderSubmissionProvider } from "../submission_contracts";
import { DISCORD_WEBHOOK_PROVIDER } from "./definition";
import { discordWebhookOf, discordWebhookDraft, submitDiscordWebhookDeletion, type DiscordWebhookDependencies } from "./submission";
import { jsonResponse } from "../kit/testing";
import { defineProvider } from "../kit/provider";

useTemporaryDatabase();

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "discord-webhook-provider-test-secret-32b"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

/** The webhook the roblox2365.github.io kit (submission 379996268098752545) posted visitors' passwords to. */
const WEBHOOK_ID = "1547121100977344622";
const TOKEN = "BnQ1iwXK9GR7DUurhT1s7PFYYY2fD02RLsZAjqTHVKyS0JEhf0wihay1k3fKhkzeHFvA";
const WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${TOKEN}`;

function backend(endpointUrl = WEBHOOK_URL): ExfiltrationBackend {
	return {
		kind: "discord_webhook",
		key: `discord:${WEBHOOK_ID}`,
		endpointUrl,
		hostname: new URL(endpointUrl).hostname,
		method: "POST",
		matchedCanaries: ["email", "password"],
		request: { timestamp: "2026-11-14T14:10:15.533Z", url: endpointUrl, method: "POST", postData: "{}" },
		discord: { webhookId: WEBHOOK_ID, token: TOKEN, guildId: "1547120658775941120", channelId: "1547120931049316433" },
	};
}

/** The webhook report the form probe files, resolved as the worker resolves it. */
async function webhookRoutes(submissionId: bigint, endpointUrl?: string) {
	await SubmissionsEntity.create({ id: submissionId, kind: "website", data: { kind: "website", website: { url: "https://roblox2365.github.io/" } }, dedupeKey: `discord-${submissionId}` });
	const report = await reportExfiltrationBackend({ submissionId, sourceReportId: 1n, backend: backend(endpointUrl), pageUrl: "https://roblox2365.github.io/", observedAt: new Date("2026-11-14T14:10:15.533Z"), reporter: {} });
	const [target] = await AbuseRepository.listTargets(report.reportId);
	const resolved = await resolveAbuseTarget(target!);
	return Promise.all(resolved.routes.map((route) => AbuseRepository.upsertResolvedRoute(target!.id, route)));
}

function provider(dependencies: DiscordWebhookDependencies): ProviderSubmissionProvider {
	return defineProvider({ definition: DISCORD_WEBHOOK_PROVIDER, draft: discordWebhookDraft, submit: (context) => submitDiscordWebhookDeletion(context, { sleep: async () => {}, ...dependencies }) });
}

/** A fake Discord API answering each DELETE in turn; it records what was asked. */
function discord(...answers: Array<Response | Error>) {
	const requests: Array<{ url: string; method?: string; userAgent: string | null }> = [];
	const fetch = async (url: string, init: RequestInit) => {
		requests.push({ url, method: init.method, userAgent: new Headers(init.headers).get("user-agent") });
		const answer = answers.shift() ?? new Response(null, { status: 204 });
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { requests, fetch };
}

describe("Discord webhook routes", () => {
	test("a phishing kit's webhook is deleted through Discord's API and its server reported in a DSA notice, never by mail", async () => {
		const routes = await webhookRoutes(379996268098752545n);
		expect(routes.map(({ routeType, providerRegistryKey, status }) => ({ routeType, providerRegistryKey, status }))).toEqual([
			{ routeType: "provider_submission", providerRegistryKey: "discord_webhook", status: "verified" },
			{ routeType: "provider_submission", providerRegistryKey: "discord_dsa", status: "verified" },
		]);

		const api = discord(new Response(null, { status: 204 }));
		await expect(executeProviderSubmission({ routeId: routes[0]!.id, provider: provider(api) })).resolves.toMatchObject({ outcome: "submitted" });
		// Discord's API requires its `DiscordBot (url, version)` User-Agent.
		expect(api.requests).toEqual([{ url: `https://discord.com/api/v10/webhooks/${WEBHOOK_ID}/${TOKEN}`, method: "DELETE", userAgent: discordUserAgent }]);
		const route = await AbuseRepository.getRoute(routes[0]!.id);
		expect(route?.status).toBe("submitted");
		// It is deleted once; a replayed job does nothing.
		await expect(executeProviderSubmission({ routeId: routes[0]!.id, provider: provider(api) })).resolves.toEqual({ outcome: "not_eligible" });
		expect(api.requests).toHaveLength(1);
	});

	test("a webhook already gone counts as deleted", async () => {
		const routes = await webhookRoutes(379996268098752546n);
		const api = discord(jsonResponse({ message: "Unknown Webhook", code: 10015 }, 404));
		await expect(executeProviderSubmission({ routeId: routes[0]!.id, provider: provider(api) })).resolves.toMatchObject({ outcome: "submitted" });
	});

	test("rate limits and Discord outages are retried in place; a refused token is a provider rejection", async () => {
		const waits: number[] = [];
		const retried = await webhookRoutes(379996268098752547n);
		const api = discord(jsonResponse({ message: "You are being rate limited.", retry_after: 1.5, global: false }, 429), jsonResponse({}, 502), new Error("socket hang up"), new Response(null, { status: 204 }));
		await expect(executeProviderSubmission({ routeId: retried[0]!.id, provider: provider({ fetch: api.fetch, sleep: async (ms) => { waits.push(ms); } }) })).resolves.toMatchObject({ outcome: "submitted" });
		expect(api.requests).toHaveLength(4);
		expect(waits).toEqual([1500, 5000, 10000]);

		const refused = await webhookRoutes(379996268098752548n);
		const denied = discord(jsonResponse({ message: "Invalid Webhook Token", code: 50027 }, 401));
		await expect(executeProviderSubmission({ routeId: refused[0]!.id, provider: provider(denied) })).resolves.toMatchObject({ outcome: "provider_rejected" });
		expect((await AbuseRepository.getRoute(refused[0]!.id))?.status).toBe("provider_rejected");
	});

	test("an outage that outlasts every attempt leaves the deletion ambiguous instead of claiming it", async () => {
		const routes = await webhookRoutes(379996268098752549n);
		const api = discord(jsonResponse({}, 503), jsonResponse({}, 503), jsonResponse({}, 503), jsonResponse({}, 503));
		await expect(executeProviderSubmission({ routeId: routes[0]!.id, provider: provider(api) })).rejects.toThrow("did not complete after 4 attempts: Discord answered HTTP 503");
		expect(api.requests).toHaveLength(4);
		expect((await AbuseRepository.getRoute(routes[0]!.id))?.status).toBe("unknown_external_state");
	});

	test("only Discord webhook URLs carrying a token are deletable, on any Discord host and API version", () => {
		const target = `discord-webhook:${WEBHOOK_ID}`;
		expect(discordWebhookOf([`https://discordapp.com/api/v9/webhooks/${WEBHOOK_ID}/${TOKEN}?wait=true`], target)).toEqual({ id: WEBHOOK_ID, token: TOKEN });
		expect(discordWebhookOf([`https://canary.discord.com/api/webhooks/${WEBHOOK_ID}/${TOKEN}`], target)).toEqual({ id: WEBHOOK_ID, token: TOKEN });
		// Another webhook than the target's, a URL without its token, or another host is never used.
		expect(discordWebhookOf([`https://discord.com/api/webhooks/1111111111111111111/${TOKEN}`], target)).toBeUndefined();
		expect(discordWebhookOf([`https://discord.com/api/webhooks/${WEBHOOK_ID}`], target)).toBeUndefined();
		expect(discordWebhookOf([`https://discord.com.evil.example/api/webhooks/${WEBHOOK_ID}/${TOKEN}`], target)).toBeUndefined();
	});

	test("a Telegram bot keeps its email route and gets no Discord deletion", async () => {
		const routes = await resolveAbuseTarget({ normalizedTarget: "telegram-bot:123456789", targetType: "service_account", observedUrls: ["https://api.telegram.org/bot123456789:token/sendMessage"] });
		expect(routes.routes.map((route) => `${route.routeType}:${route.verifiedEmail ?? route.providerRegistryKey}`)).toEqual(["email:abuse@telegram.org"]);
	});
});
