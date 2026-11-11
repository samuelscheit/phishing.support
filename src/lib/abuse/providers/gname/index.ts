import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { GNAME_PROVIDER } from "./definition";
import { makeGnameDescription } from "./payload";
import { prepareGnameExternalSubmission, prepareGnameSubmission, submitGnameSubmission } from "./submission";

/** GNAME (IANA 1923 and its sibling accreditations) takes abuse complaints through its own form, gated by a slider and a mailed code. */
export const gnameProvider: ProviderSubmissionProvider = {
	definition: GNAME_PROVIDER,
	prepareSubmission: prepareGnameSubmission,
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "gname_abuse_complaint_v1",
	buildReportPreview: (context: ProviderReportPreviewContext) => makeGnameDescription({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
	}),
	prepareExternalSubmission: prepareGnameExternalSubmission,
	// The executor always calls submitPrepared: the code lives in the preflight's browser session.
	submit: (context) => submitGnameSubmission(context, undefined),
	submitPrepared: (context, preflight) => submitGnameSubmission(context, preflight),
	// GNAME mails its case number when it receives and when it settles a complaint.
	inboundMail: {
		senderDomains: ["gname.com"],
		confirmationIds: (text) => [...new Set([...text.matchAll(/\bcase\s*(?:no\.?|number)\s*[:：]?\s*([A-Z0-9-]{6,40})\b/gi)].map((match) => match[1]!))],
	},
};

export { GNAME_PROVIDER } from "./definition";
