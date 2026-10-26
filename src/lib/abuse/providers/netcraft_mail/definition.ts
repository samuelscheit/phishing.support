import { hashStableJson } from "../../security";
import { NETCRAFT_REPORT_MAIL_URL } from "../../../netcraft/api";
import type { ProviderSubmissionDefinition } from "../submission_contracts";
import { MAX_REPORTED_EMAIL_BYTES } from "../../submission_reports";

/** Code-owned contract for Netcraft Reporting API v3 raw-email submissions. */
export type NetcraftMailProviderDefinition = ProviderSubmissionDefinition & {
	reportMailUrl: string;
	maximumMessageBytes: number;
};

const definitionWithoutHash = {
	key: "netcraft_mail",
	displayName: "Netcraft",
	version: "2026-10-26.1",
	exactMailboxes: [],
	supplemental: true,
	supplementalTargets: [{ targetType: "email" as const }],
	reportMailUrl: NETCRAFT_REPORT_MAIL_URL,
	maximumMessageBytes: MAX_REPORTED_EMAIL_BYTES,
};

export const NETCRAFT_MAIL_PROVIDER: NetcraftMailProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});
