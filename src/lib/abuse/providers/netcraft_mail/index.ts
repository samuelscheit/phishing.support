import type { ProviderSubmissionProvider } from "../submission_contracts";
import { NETCRAFT_MAIL_PROVIDER } from "./definition";
import { prepareNetcraftMailSubmission, submitNetcraftMailSubmission } from "./submission";

/** Supplemental Netcraft route that files the reported phishing message itself. */
export const netcraftMailProvider: ProviderSubmissionProvider = {
	definition: NETCRAFT_MAIL_PROVIDER,
	prepareSubmission: prepareNetcraftMailSubmission,
	buildReportPreview: () => "The recipient-redacted original phishing email (RFC 822 source) is submitted to Netcraft's mail-report API.",
	submit: submitNetcraftMailSubmission,
};

export { NETCRAFT_MAIL_PROVIDER } from "./definition";
