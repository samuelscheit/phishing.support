import { NETCRAFT_REPORT_MAIL_URL } from "../../../netcraft/api";
import { definePinned } from "../kit/pin";
import { MAX_REPORTED_EMAIL_BYTES } from "../../submission_reports";

/** Code-owned contract for Netcraft Reporting API v3 raw-email submissions. */

export const NETCRAFT_MAIL_PROVIDER = definePinned({
	key: "netcraft_mail",
	displayName: "Netcraft",
	version: "2026-10-26.1",
	exactMailboxes: [],
	supplemental: true,
	supplementalTargets: [{ targetType: "email" as const }],
	reportMailUrl: NETCRAFT_REPORT_MAIL_URL,
	maximumMessageBytes: MAX_REPORTED_EMAIL_BYTES,
});

