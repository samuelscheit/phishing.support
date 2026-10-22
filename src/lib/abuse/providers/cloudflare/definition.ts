import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type CloudflareProviderDefinition = ProviderSubmissionDefinition & {
	apiBaseUrl: string;
	reportType: "abuse_phishing";
	dashboardUrl: string;
	maximumJustificationLength: number;
};

const definitionWithoutHash = {
	key: "cloudflare",
	displayName: "Cloudflare Abuse",
	version: "2026-10-22.1",
	exactMailboxes: ["abuse@cloudflare.com"],
	supplemental: false,
	apiBaseUrl: "https://api.cloudflare.com/client/v4",
	reportType: "abuse_phishing" as const,
	dashboardUrl: "https://dash.cloudflare.com",
	maximumJustificationLength: 3_000,
};

/** Reviewed API contract and route-selection metadata for Cloudflare. */
export const CLOUDFLARE_PROVIDER: CloudflareProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
