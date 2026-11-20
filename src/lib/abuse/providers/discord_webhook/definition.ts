import { definePinned } from "../kit/pin";

/** A Discord webhook URL: its ID and the token that authorizes posting to, and deleting, it. */
export const DISCORD_WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{17,20})\/([\w-]{20,100})(?:[/?#]|$)/;

/** Code-owned contract for deleting a phishing kit's Discord webhook through Discord's API. */

export const DISCORD_WEBHOOK_PROVIDER = definePinned({
	key: "discord_webhook",
	displayName: "Discord webhook deletion",
	version: "2026-11-14.1",
	exactMailboxes: [],
	supplemental: true,
	supplementalTargets: [{ targetType: "service_account" as const, requiresObservedUrl: true, observedUrlPattern: DISCORD_WEBHOOK_URL.source }],
	apiBase: "https://discord.com/api/v10",
});

