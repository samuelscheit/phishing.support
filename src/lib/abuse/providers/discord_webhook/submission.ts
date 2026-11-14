import { recordValue, routeContext } from "../../worker/shared";
import { providerDefinitionMatchesPin } from "../definition";
import {
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { DISCORD_WEBHOOK_PROVIDER, DISCORD_WEBHOOK_URL } from "./definition";

export type DiscordWebhookPayload = {
	adapter: "discord_webhook_delete_v1";
	definition: { version: string; contentHash: string };
	webhook: { id: string; token: string };
};

export type DiscordWebhookDependencies = {
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
};

/** Discord's error code for a webhook that does not exist (any more). */
const UNKNOWN_WEBHOOK = 10015;
/** Deleting is idempotent, so a rate limit or a Discord outage is retried in place rather than left ambiguous. */
const MAX_ATTEMPTS = 4;
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const SERVER_ERROR_BACKOFF_MS = [2_000, 5_000, 10_000];

/** The webhook a route's target names, read from the URL the kit posted the probe's data to. */
export function discordWebhookOf(observedUrls: readonly string[], normalizedTarget: string): { id: string; token: string } | undefined {
	for (const url of observedUrls) {
		const match = DISCORD_WEBHOOK_URL.exec(url);
		if (match && normalizedTarget === `discord-webhook:${match[1]}`) return { id: match[1]!, token: match[2]! };
	}
	return undefined;
}

function storedPayload(value: unknown): DiscordWebhookPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const webhook = payload && recordValue(payload.webhook);
	if (payload?.adapter !== "discord_webhook_delete_v1"
		|| definition?.version !== DISCORD_WEBHOOK_PROVIDER.version || definition.contentHash !== DISCORD_WEBHOOK_PROVIDER.contentHash
		|| typeof webhook?.id !== "string" || !/^\d{17,20}$/.test(webhook.id) || typeof webhook.token !== "string" || !/^[\w-]{20,100}$/.test(webhook.token)) {
		return undefined;
	}
	return { adapter: "discord_webhook_delete_v1", definition: { version: definition.version, contentHash: definition.contentHash }, webhook: { id: webhook.id, token: webhook.token } };
}

export async function prepareDiscordWebhookDeletion(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const { route, target } = await routeContext(context.routeId);
	if (route.providerRegistryKey !== DISCORD_WEBHOOK_PROVIDER.key || target.targetType !== "service_account") {
		return { outcome: "insufficient_evidence", reason: "discord_webhook_requires_a_webhook_target" };
	}
	if (!providerDefinitionMatchesPin(DISCORD_WEBHOOK_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "discord_webhook_provider_definition_pin_mismatch" };
	}
	const webhook = discordWebhookOf(target.observedUrls, target.normalizedTarget);
	if (!webhook) return { outcome: "insufficient_evidence", reason: "discord_webhook_url_with_token_not_observed" };
	return {
		outcome: "ready",
		payload: {
			adapter: "discord_webhook_delete_v1",
			definition: { version: DISCORD_WEBHOOK_PROVIDER.version, contentHash: DISCORD_WEBHOOK_PROVIDER.contentHash },
			webhook,
		} satisfies DiscordWebhookPayload,
	};
}

async function discordError(response: Response): Promise<{ code?: number; message?: string; retryAfterMs?: number }> {
	const body = recordValue(await response.json().catch(() => undefined));
	const retryAfter = typeof body?.retry_after === "number" ? body.retry_after : Number(response.headers.get("retry-after"));
	return {
		...(typeof body?.code === "number" ? { code: body.code } : {}),
		...(typeof body?.message === "string" ? { message: body.message } : {}),
		...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: Math.ceil(retryAfter * 1000) } : {}),
	};
}

/**
 * Delete the webhook with the token the kit itself carries, as Discord's API
 * allows any holder of it to (DELETE /webhooks/{id}/{token}): the kit can
 * no longer post what its visitors type to its operator's channel. A webhook
 * already gone counts as done; a token Discord no longer accepts is a refusal.
 */
export async function submitDiscordWebhookDeletion(context: ProviderSubmissionContext, dependencies: DiscordWebhookDependencies = {}): Promise<ProviderSubmissionSuccess> {
	const payload = storedPayload(context.payload);
	if (!payload) throw new ProviderSubmissionRejectedError("The stored Discord webhook payload is malformed.");
	const { id, token } = payload.webhook;
	const fetcher = dependencies.fetch ?? fetch;
	const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const submittedTargets = [`discord-webhook:${id}`];
	let lastFailure = "";
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		let response: Response;
		try {
			response = await fetcher(`${DISCORD_WEBHOOK_PROVIDER.apiBase}/webhooks/${id}/${token}`, {
				method: "DELETE",
				headers: { "user-agent": "PhishingSupport (https://phishing.support, 1.0)" },
				...(context.signal ? { signal: context.signal } : {}),
			});
		} catch (error) {
			if (context.signal?.aborted) throw error;
			lastFailure = `the request failed (${error instanceof Error ? error.message : String(error)})`;
			await sleep(SERVER_ERROR_BACKOFF_MS[attempt] ?? SERVER_ERROR_BACKOFF_MS.at(-1)!);
			continue;
		}
		if (response.status === 204) {
			return { confirmationId: id, confirmationText: `Discord deleted webhook ${id}; the kit can no longer post to its channel.`, submittedTargets };
		}
		const error = await discordError(response);
		if (response.status === 404 && error.code === UNKNOWN_WEBHOOK) {
			return { confirmationId: id, confirmationText: `Webhook ${id} no longer exists at Discord; it was already deleted.`, submittedTargets };
		}
		if (response.status === 429) {
			lastFailure = "Discord rate-limited the request";
			await sleep(Math.min(error.retryAfterMs ?? 1_000, MAX_RATE_LIMIT_WAIT_MS));
			continue;
		}
		if (response.status >= 500) {
			lastFailure = `Discord answered HTTP ${response.status}`;
			await sleep(SERVER_ERROR_BACKOFF_MS[attempt] ?? SERVER_ERROR_BACKOFF_MS.at(-1)!);
			continue;
		}
		throw new ProviderSubmissionRejectedError(`Discord refused to delete webhook ${id}: HTTP ${response.status}${error.code ? ` (code ${error.code})` : ""}${error.message ? `: ${error.message}` : ""}.`);
	}
	throw new Error(`Deleting Discord webhook ${id} did not complete after ${MAX_ATTEMPTS} attempts: ${lastFailure}.`);
}
