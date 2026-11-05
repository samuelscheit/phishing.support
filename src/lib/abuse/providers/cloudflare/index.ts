import { extractTurnstileSitekeys } from "../../followup/account_identifiers";
import type { ProviderSubmissionProvider } from "../submission_contracts";

import { CLOUDFLARE_PROVIDER } from "./definition";
import { buildCloudflareReportPreview } from "./report";
import { fetchCloudflareCorrespondence, prepareCloudflareExternalSubmission, prepareCloudflareSubmission, submitCloudflareSubmission } from "./submission";

/** The sole executable owner of Cloudflare's authenticated abuse-report API contract. */
export const cloudflareProvider: ProviderSubmissionProvider = {
	definition: CLOUDFLARE_PROVIDER,
	prepareSubmission: (context) => prepareCloudflareSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "cloudflare_abuse_api_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: buildCloudflareReportPreview,
	// Cloudflare's decision mail: "please send an email to abusereply@cloudflare.com with
	// the report identification number included in the subject line".
	decisionFollowUp: {
		contestedStates: ["denied"],
		replyAddress: "abusereply@cloudflare.com",
		subject: (confirmationId) => `[${confirmationId}] Additional evidence for abuse report ${confirmationId}`,
		// A Turnstile widget's sitekey names the Cloudflare account that created it.
		accountIdentifiers: extractTurnstileSitekeys,
	},
	prepareExternalSubmission: (context) => prepareCloudflareExternalSubmission(context),
	submit: (context) => submitCloudflareSubmission(context),
	submitPrepared: (context, preflight) => submitCloudflareSubmission(context, {}, preflight),
	// The submitted-report API is the authoritative record of Cloudflare's
	// correspondence; its notification mails are not attached a second time.
	inboundMail: { senderDomains: ["cloudflare.com"] },
	fetchCorrespondence: (context) => fetchCloudflareCorrespondence(context),
};

export { CLOUDFLARE_PROVIDER } from "./definition";
export { buildCloudflareReportPayload, buildCloudflareReportPreview } from "./report";
