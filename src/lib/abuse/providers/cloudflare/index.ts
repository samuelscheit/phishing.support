import { extractTurnstileSitekeys } from "../../followup/account_identifiers";
import type { ProviderSubmissionProvider } from "../submission_contracts";

import { CLOUDFLARE_PROVIDER } from "./definition";
import { buildCloudflareReportPreview } from "./report";
import { cloudflareDraft, fetchCloudflareCorrespondence, findCloudflareSubmission, prepareCloudflareExternalSubmission, submitCloudflareSubmission } from "./submission";

/** The sole executable owner of Cloudflare's authenticated abuse-report API contract. */
export const cloudflareProvider: ProviderSubmissionProvider = {
	definition: CLOUDFLARE_PROVIDER,
	prepareSubmission: cloudflareDraft.prepare,
	verifyDraft: cloudflareDraft.verify,
	buildReportPreview: buildCloudflareReportPreview,
	// Cloudflare's decision mail: "please send an email to abusereply@cloudflare.com with
	// the report identification number included in the subject line".
	decisionFollowUp: {
		contestedStates: ["denied"],
		addressee: "Cloudflare",
		channel: {
			kind: "email",
			replyAddress: "abusereply@cloudflare.com",
			subject: (confirmationId) => `[${confirmationId}] Additional evidence for abuse report ${confirmationId}`,
		},
		// A Turnstile widget's sitekey names the Cloudflare account that created it.
		accountIdentifiers: extractTurnstileSitekeys,
	},
	prepareExternalSubmission: (context) => prepareCloudflareExternalSubmission(context),
	// The executor always calls submitPrepared: the dashboard session lives in the preflight.
	submit: (context) => submitCloudflareSubmission(context, undefined),
	submitPrepared: submitCloudflareSubmission,
	findSubmission: (context) => findCloudflareSubmission(context),
	// The submitted-report API is the authoritative record of Cloudflare's
	// correspondence; its notification mails are not attached a second time.
	inboundMail: { senderDomains: ["cloudflare.com"] },
	fetchCorrespondence: (context) => fetchCloudflareCorrespondence(context),
	reviewVerdicts: { accepted: "acknowledged", denied: "rejected" },
};

