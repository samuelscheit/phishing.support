import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

/** Code-owned contract for Netcraft Reporting API v3 URL submissions. */
export type NetcraftProviderDefinition = ProviderSubmissionDefinition & {
	reportUrlsUrl: string;
	submissionUrlPrefix: string;
	maximumUrlsPerSubmission: number;
	maximumReasonLength: number;
};

const definitionWithoutHash = {
	key: "netcraft",
	displayName: "Netcraft",
	version: "2026-08-14.1",
	exactMailboxes: [],
	supplemental: true,
	supplementalTargets: [{ targetType: "domain" as const, requiresObservedUrl: true as const }],
	reportUrlsUrl: "https://report.netcraft.com/api/v3/report/urls",
	submissionUrlPrefix: "https://report.netcraft.com/api/v3/submission/",
	maximumUrlsPerSubmission: 1_000,
	maximumReasonLength: 10_000,
};

export const NETCRAFT_PROVIDER: NetcraftProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
