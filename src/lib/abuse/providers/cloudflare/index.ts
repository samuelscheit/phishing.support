import { extractTurnstileSitekeys } from "../../followup/account_identifiers";
import { defineProvider } from "../kit/provider";

import { CLOUDFLARE_PROVIDER } from "./definition";
import { buildCloudflareReportPreview } from "./report";
import { cloudflareDraft, fetchCloudflareCorrespondence, findCloudflareSubmission, prepareCloudflareExternalSubmission, storedCloudflareSubmissionPayload, submitCloudflareSubmission } from "./submission";

/** The sole executable owner of Cloudflare's authenticated abuse-report API contract. */
export const cloudflareProvider = defineProvider({
	definition: CLOUDFLARE_PROVIDER,
	draft: cloudflareDraft,
	preview: buildCloudflareReportPreview,
	// The dashboard session lives in the preflight.
	external: { prepare: prepareCloudflareExternalSubmission, submit: submitCloudflareSubmission },
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
	findSubmission: findCloudflareSubmission,
	reportedUrls: (payload) => {
		const stored = storedCloudflareSubmissionPayload(payload);
		return stored ? [stored.report.urls] : [];
	},
	// The submitted-report API is the authoritative record of Cloudflare's
	// correspondence; its notification mails are not attached a second time.
	inbound: { senderDomains: ["cloudflare.com"], confirmationIds: null },
	fetchCorrespondence: fetchCloudflareCorrespondence,
	reviewVerdicts: { accepted: "acknowledged", denied: "rejected" },
});
