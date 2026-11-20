import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { reportReferencesIn } from "../report_reference";
import { TUCOWS_PROVIDER } from "./definition";
import { makeTucowsDescription, tucowsBrand, tucowsReportUrls } from "./payload";
import { prepareTucowsExternalSubmission, prepareTucowsSubmission, submitTucowsSubmission } from "./submission";

/**
 * Tucows (and its Enom brand) no longer read their abuse mailboxes; the route
 * files through Tucows' web form, behind a Turnstile token and a mailed code.
 * Its Freshdesk case mail goes to the service mailbox and quotes our reference,
 * so it is read as a reply: it can ask for more.
 */
export const tucowsProvider: ProviderSubmissionProvider = {
	definition: TUCOWS_PROVIDER,
	prepareSubmission: (context) => prepareTucowsSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "tucows_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => {
		const urls = tucowsReportUrls(context.target, context.observedUrls);
		if (urls.length === 0 || context.allegationCategory === "malware" || !tucowsBrand(context.description, context.legalBrandUrl)) return undefined;
		return makeTucowsDescription({
			target: context.target,
			observedUrls: context.observedUrls,
			description: context.description,
			legalBrandUrl: context.legalBrandUrl ?? null,
			reference: "PS-000000000000-R0",
		}, urls);
	},
	prepareExternalSubmission: (context) => prepareTucowsExternalSubmission(context),
	// The executor always calls submitPrepared: the wizard session lives in the preflight.
	submit: (context) => submitTucowsSubmission(context, undefined),
	submitPrepared: (context, preflight) => submitTucowsSubmission(context, preflight),
	inboundMail: {
		// Case acknowledgements from Tucows' Freshdesk desk.
		senderDomains: ["tucows.com"],
		confirmationIds: reportReferencesIn,
		messageKind: "reply",
	},
};

