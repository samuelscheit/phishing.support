import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type CloudflareProviderDefinition = ProviderSubmissionDefinition & {
	formUrl: string;
	responsePath: string;
	maximumJustificationLength: number;
};

const definitionWithoutHash = {
	key: "cloudflare",
	displayName: "Cloudflare Abuse",
	version: "2026-08-14.1",
	exactMailboxes: ["abuse@cloudflare.com"],
	supplemental: false,
	formUrl: "https://abuse.cloudflare.com/phishing",
	responsePath: "/api/v2/form/abuse_phishing",
	maximumJustificationLength: 3_000,
};

/** Reviewed form contract and route-selection metadata for Cloudflare. */
export const CLOUDFLARE_PROVIDER: CloudflareProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
