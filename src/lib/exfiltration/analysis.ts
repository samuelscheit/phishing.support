import { normalizeDomain } from "../abuse/security";
import type { CapturedNetworkRequest, ExfiltrationBackend, ExfiltrationCanaries } from "./types";

const TELEGRAM_ENDPOINT = /^\/bot([^/]+)\/(?:sendMessage|sendPhoto|sendDocument|sendMediaGroup|sendVideo|sendAudio|sendVoice|sendAnimation)(?:\/|$)/i;
const DISCORD_ENDPOINT = /^\/api(?:\/v\d+)?\/webhooks\/(\d{1,20})\/([^/?#]+)/i;
const BASE64_RUN = /(?:[A-Za-z0-9+/]{12,}={0,2}|[A-Za-z0-9_-]{12,})/g;

function decodedRepresentations(value: string): string[] {
	const values = new Set([value]);
	let decoded = value;
	for (let index = 0; index < 2; index++) {
		try {
			const next = decodeURIComponent(decoded.replace(/\+/g, "%20"));
			if (next === decoded) break;
			values.add(next);
			decoded = next;
		} catch {
			break;
		}
	}
	for (const match of (value.match(BASE64_RUN) ?? []).slice(0, 64)) {
		try {
			const normalized = match.replace(/-/g, "+").replace(/_/g, "/");
			const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
			const buffer = Buffer.from(padded, "base64");
			if (buffer.byteLength && buffer.byteLength <= 128 * 1024) values.add(buffer.toString("utf8"));
		} catch {
			// A base64-shaped run is only an optional representation.
		}
	}
	return [...values];
}

export function matchedCanaries(request: CapturedNetworkRequest, canaries: ExfiltrationCanaries): Array<keyof ExfiltrationCanaries> {
	const representations = [request.url, request.postData, request.webSocketPayload]
		.filter((value): value is string => Boolean(value))
		.flatMap(decodedRepresentations);
	return (Object.entries(canaries) as Array<[keyof ExfiltrationCanaries, string]>)
		.filter(([, value]) => representations.some((candidate) => candidate.includes(value)))
		.map(([key]) => key);
}

function chatId(request: CapturedNetworkRequest): string | undefined {
	for (const raw of [request.postData, new URL(request.url).search.slice(1)]) {
		if (!raw) continue;
		try {
			const json = JSON.parse(raw) as Record<string, unknown>;
			const value = json.chat_id;
			if (typeof value === "string" || typeof value === "number") return String(value);
		} catch {
			const value = new URLSearchParams(raw).get("chat_id");
			if (value) return value;
		}
	}
	return undefined;
}

/** Classify only cross-origin requests which demonstrably carried one of this probe's values. */
export function discoverExfiltrationBackends(params: {
	requests: CapturedNetworkRequest[];
	canaries: ExfiltrationCanaries;
	pageUrl: string;
}): ExfiltrationBackend[] {
	const pageHost = normalizeDomain(new URL(params.pageUrl).hostname) ?? new URL(params.pageUrl).hostname.toLowerCase();
	const discoveries = new Map<string, ExfiltrationBackend>();
	for (const request of params.requests) {
		const matches = matchedCanaries(request, params.canaries);
		if (matches.length === 0) continue;
		let endpoint: URL;
		try {
			endpoint = new URL(request.url);
		} catch {
			continue;
		}
		if (!["http:", "https:", "ws:", "wss:"].includes(endpoint.protocol)) continue;
		const hostname = normalizeDomain(endpoint.hostname) ?? endpoint.hostname.toLowerCase();
		if (!hostname || hostname === pageHost) continue;

		let backend: ExfiltrationBackend;
		const telegram = hostname === "api.telegram.org" ? TELEGRAM_ENDPOINT.exec(endpoint.pathname) : null;
		const discord = ["discord.com", "discordapp.com"].includes(hostname) ? DISCORD_ENDPOINT.exec(endpoint.pathname) : null;
		if (telegram) {
			const token = telegram[1]!;
			const telegramChatId = chatId(request);
			backend = {
				kind: "telegram_bot",
				key: `telegram-token:${token}`,
				endpointUrl: request.url,
				hostname,
				method: request.method,
				matchedCanaries: matches,
				request,
				telegram: { token, ...(telegramChatId ? { chatId: telegramChatId } : {}) },
			};
		} else if (discord) {
			backend = {
				kind: "discord_webhook",
				key: `discord-webhook:${discord[1]}`,
				endpointUrl: request.url,
				hostname,
				method: request.method,
				matchedCanaries: matches,
				request,
				discord: { webhookId: discord[1]!, token: discord[2]! },
			};
		} else {
			backend = {
				kind: "domain",
				key: `domain:${hostname}`,
				endpointUrl: request.url,
				hostname,
				method: request.method,
				matchedCanaries: matches,
				request,
			};
		}
		const existing = discoveries.get(backend.key);
		if (!existing || backend.matchedCanaries.length > existing.matchedCanaries.length) discoveries.set(backend.key, backend);
	}
	return [...discoveries.values()];
}
