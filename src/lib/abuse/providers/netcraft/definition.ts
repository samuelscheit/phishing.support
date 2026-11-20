import { NETCRAFT_REPORT_URLS_URL, NETCRAFT_SUBMISSION_URL_PREFIX } from "../../../netcraft/api";
import { definePinned } from "../kit/pin";

/** Code-owned contract for Netcraft Reporting API v3 URL submissions. */

export const NETCRAFT_PROVIDER = definePinned({
	key: "netcraft",
	displayName: "Netcraft",
	version: "2026-10-27.1",
	exactMailboxes: [],
	supplemental: true,
	supplementalTargets: [
		{ targetType: "domain" as const, requiresObservedUrl: true as const },
		{ targetType: "ip" as const, requiresObservedUrl: true as const },
	],
	reportUrlsUrl: NETCRAFT_REPORT_URLS_URL,
	submissionUrlPrefix: NETCRAFT_SUBMISSION_URL_PREFIX,
	maximumUrlsPerSubmission: 1_000,
	maximumReasonLength: 10_000,
});

