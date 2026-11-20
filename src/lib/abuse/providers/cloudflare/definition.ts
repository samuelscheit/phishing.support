import { definePinned } from "../kit/pin";

export const CLOUDFLARE_PROVIDER = definePinned({
	key: "cloudflare",
	displayName: "Cloudflare Abuse",
	version: "2026-10-23.1",
	exactMailboxes: ["abuse@cloudflare.com"],
	supplemental: false,
	apiBaseUrl: "https://dash.cloudflare.com/api/v4",
	reportType: "abuse_phishing" as const,
	dashboardUrl: "https://dash.cloudflare.com",
	maximumJustificationLength: 3_000,
});

/** Reviewed API contract and route-selection metadata for Cloudflare. */

