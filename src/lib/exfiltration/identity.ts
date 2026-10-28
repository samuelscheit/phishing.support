import type { ExfiltrationBackend } from "./types";

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const LOOKUP_TIMEOUT_MS = 12_000;

async function boundedFetch(fetchImplementation: FetchImplementation, url: URL, signal?: AbortSignal): Promise<Response> {
	const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	return fetchImplementation(url, { method: "GET", headers: { accept: "application/json" }, signal: combined });
}

/** `getMe` reads only the bot's public identity; it never reads updates or changes bot state. */
export async function enrichTelegramBot(
	backend: ExfiltrationBackend,
	fetchImplementation: FetchImplementation = globalThis.fetch,
	signal?: AbortSignal,
): Promise<ExfiltrationBackend> {
	if (!backend.telegram) return backend;
	if (!/^\d{1,20}:[A-Za-z0-9_-]{8,256}$/.test(backend.telegram.token)) return backend;
	const url = new URL(`https://api.telegram.org/bot${backend.telegram.token}/getMe`);
	const response = await boundedFetch(fetchImplementation, url, signal);
	if (!response.ok) return backend;
	const body = await response.json().catch(() => undefined) as { ok?: unknown; result?: { id?: unknown; username?: unknown } } | undefined;
	if (body?.ok !== true || !body.result) return backend;
	const botId = typeof body.result.id === "number" || typeof body.result.id === "string" ? String(body.result.id) : undefined;
	const username = typeof body.result.username === "string" && body.result.username.trim() ? body.result.username : undefined;
	return { ...backend, telegram: { ...backend.telegram, ...(botId ? { botId } : {}), ...(username ? { username } : {}) } };
}

/** Discord's documented GET-webhook operation returns metadata and performs no mutation. */
export async function enrichDiscordWebhook(
	backend: ExfiltrationBackend,
	fetchImplementation: FetchImplementation = globalThis.fetch,
	signal?: AbortSignal,
): Promise<ExfiltrationBackend> {
	if (!backend.discord) return backend;
	if (!/^\d{1,20}$/.test(backend.discord.webhookId) || !/^[A-Za-z0-9._-]{8,256}$/.test(backend.discord.token)) return backend;
	const url = new URL(`https://discord.com/api/v10/webhooks/${backend.discord.webhookId}/${backend.discord.token}`);
	const response = await boundedFetch(fetchImplementation, url, signal);
	if (!response.ok) return backend;
	const body = await response.json().catch(() => undefined) as { guild_id?: unknown; channel_id?: unknown; name?: unknown } | undefined;
	if (!body) return backend;
	const string = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
	const guildId = string(body.guild_id);
	const channelId = string(body.channel_id);
	const name = string(body.name);
	return {
		...backend,
		discord: {
			...backend.discord,
			...(guildId ? { guildId } : {}),
			...(channelId ? { channelId } : {}),
			...(name ? { name } : {}),
		},
	};
}

export async function enrichBackendIdentity(
	backend: ExfiltrationBackend,
	fetchImplementation: FetchImplementation = globalThis.fetch,
	signal?: AbortSignal,
): Promise<ExfiltrationBackend> {
	if (backend.kind === "telegram_bot") return enrichTelegramBot(backend, fetchImplementation, signal);
	if (backend.kind === "discord_webhook") return enrichDiscordWebhook(backend, fetchImplementation, signal);
	return backend;
}
