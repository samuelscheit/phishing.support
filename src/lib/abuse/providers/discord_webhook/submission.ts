import { z } from "zod";

import { sleep, type Sleep } from "../../../util/sleep";
import { asRecord } from "../../../util/values";
import { createDraft } from "../kit/draft";
import { payloadEnvelope, storedReader } from "../kit/stored";
import { ProviderSubmissionRejectedError, type ProviderSubmissionContext, type ProviderSubmissionSuccess } from "../submission_contracts";
import { DISCORD_WEBHOOK_PROVIDER, DISCORD_WEBHOOK_URL } from "./definition";

const envelope = payloadEnvelope(DISCORD_WEBHOOK_PROVIDER, "discord_webhook_delete_v1");

const payloadSchema = z.object({
	...envelope.shape,
	webhook: z.object({ id: z.string().regex(/^\d{17,20}$/), token: z.string().regex(/^[\w-]{20,100}$/) }),
});

export type DiscordWebhookDependencies = {
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
	sleep?: Sleep;
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

export const discordWebhookDraft = createDraft({
	definition: DISCORD_WEBHOOK_PROVIDER,
	reasonPrefix: "discord_webhook",
	targetTypes: ["service_account"],
	targetReason: "discord_webhook_requires_a_webhook_target",
	read: storedReader(payloadSchema),
	input: ({ target }) => discordWebhookOf(target.observedUrls, target.normalizedTarget),
	admit: (_data, webhook) => webhook ? undefined : "discord_webhook_url_with_token_not_observed",
	build: (webhook) => webhook && { ...envelope.stamp, webhook },
	targetOf: ({ webhook }) => `discord-webhook:${webhook.id}`,
});

export const prepareDiscordWebhookDeletion = discordWebhookDraft.prepare;

async function discordError(response: Response): Promise<{ code?: number; message?: string; retryAfterMs?: number }> {
	const body = asRecord(await response.json().catch(() => undefined));
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
	const payload = discordWebhookDraft.stored(context);
	const { id, token } = payload.webhook;
	const fetcher = dependencies.fetch ?? fetch;
	const wait = dependencies.sleep ?? sleep;
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
			await wait(SERVER_ERROR_BACKOFF_MS[attempt] ?? SERVER_ERROR_BACKOFF_MS.at(-1)!);
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
			await wait(Math.min(error.retryAfterMs ?? 1_000, MAX_RATE_LIMIT_WAIT_MS));
			continue;
		}
		if (response.status >= 500) {
			lastFailure = `Discord answered HTTP ${response.status}`;
			await wait(SERVER_ERROR_BACKOFF_MS[attempt] ?? SERVER_ERROR_BACKOFF_MS.at(-1)!);
			continue;
		}
		throw new ProviderSubmissionRejectedError(`Discord refused to delete webhook ${id}: HTTP ${response.status}${error.code ? ` (code ${error.code})` : ""}${error.message ? `: ${error.message}` : ""}.`);
	}
	throw new Error(`Deleting Discord webhook ${id} did not complete after ${MAX_ATTEMPTS} attempts: ${lastFailure}.`);
}
