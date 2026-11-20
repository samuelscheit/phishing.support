import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { reportReferencesIn } from "../report_reference";
import { DYNADOT_PROVIDER } from "./definition";
import { dynadotReportUrls, makeDynadotComments } from "./payload";
import { normalizeDomain } from "../../security";
import { prepareDynadotExternalSubmission, prepareDynadotSubmission, submitDynadotSubmission } from "./submission";

/**
 * Dynadot's abuse mailbox is not monitored; the route files the report through
 * its abuse form from a real Chrome. The form shows no case id and promises no
 * reply, so any mail is read as a reply and matched by our reference.
 */
export const dynadotProvider: ProviderSubmissionProvider = {
	definition: DYNADOT_PROVIDER,
	prepareSubmission: (context) => prepareDynadotSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "dynadot_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => {
		const domain = normalizeDomain(context.target);
		const urls = domain ? dynadotReportUrls(domain, context.observedUrls) : [];
		return domain && urls.length > 0 ? makeDynadotComments({
			target: domain,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: "PS-000000000000-R0",
		}, urls) : undefined;
	},
	prepareExternalSubmission: (context) => prepareDynadotExternalSubmission(context),
	// The executor always calls submitPrepared: the Turnstile token and the page live in the preflight's browser session.
	submit: (context) => submitDynadotSubmission(context, undefined),
	submitPrepared: (context, preflight) => submitDynadotSubmission(context, preflight),
	inboundMail: {
		senderDomains: ["dynadot.com"],
		confirmationIds: reportReferencesIn,
		messageKind: "reply",
	},
};

export { DYNADOT_PROVIDER } from "./definition";
