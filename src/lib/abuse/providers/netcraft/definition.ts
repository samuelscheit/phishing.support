import { hashStableJson } from "../../security";
import { NETCRAFT_REPORT_URLS_URL, NETCRAFT_SUBMISSION_URL_PREFIX } from "../../../netcraft/api";
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
	version: "2026-08-30.1",
	exactMailboxes: [],
	supplemental: true,
	supplementalTargets: [{ targetType: "domain" as const, requiresObservedUrl: true as const }],
	reportUrlsUrl: NETCRAFT_REPORT_URLS_URL,
	submissionUrlPrefix: NETCRAFT_SUBMISSION_URL_PREFIX,
	maximumUrlsPerSubmission: 1_000,
	maximumReasonLength: 10_000,
};

export const NETCRAFT_PROVIDER: NetcraftProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
