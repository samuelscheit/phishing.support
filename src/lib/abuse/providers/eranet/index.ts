import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { fetchEranetCorrespondence } from "./correspondence";
import { submitEranetSupplement } from "./supplement";
import { ERANET_PROVIDER } from "./definition";
import { makeEranetDescription } from "./payload";
import { prepareEranetExternalSubmission, prepareEranetSubmission, submitEranetSubmission } from "./submission";

/** Eranet (IANA 1868) takes abuse reports through its own form, gated by a mailed code. */
export const eranetProvider: ProviderSubmissionProvider = {
	definition: ERANET_PROVIDER,
	prepareSubmission: prepareEranetSubmission,
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "eranet_phishing_report_v1",
	buildReportPreview: (context: ProviderReportPreviewContext) => makeEranetDescription({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	prepareExternalSubmission: prepareEranetExternalSubmission,
	// The executor always calls submitPrepared: the code lives in the preflight's browser session.
	submit: (context) => submitEranetSubmission(context, undefined),
	submitPrepared: (context, preflight) => submitEranetSubmission(context, preflight),
	// Eranet answers in its portal; its mails only say that the status changed.
	inboundMail: { senderDomains: ["eranet.com"] },
	fetchCorrespondence: (context) => fetchEranetCorrespondence(context),
	// "Supplement required": Eranet could not confirm the abuse from the report and waits on more material.
	decisionFollowUp: {
		contestedStates: ["supplement required"],
		addressee: "Eranet",
		channel: { kind: "form", name: "Eranet's supplement form", submit: (answer, markSending) => submitEranetSupplement(answer, markSending) },
	},
};

export { ERANET_PROVIDER } from "./definition";
