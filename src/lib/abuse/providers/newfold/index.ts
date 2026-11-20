import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { reportReferencesIn } from "../report_reference";
import { NEWFOLD_PROVIDER } from "./definition";
import { makeNewfoldComments, newfoldReportUrls } from "./payload";
import { normalizeDomain } from "../../security";
import { prepareNewfoldExternalSubmission, prepareNewfoldSubmission, submitNewfoldSubmission } from "./submission";

/**
 * Newfold's abuse mailboxes are not monitored; the route files the report
 * through newfold.com/abuse from a real Chrome (reCAPTCHA solved through Death
 * by Captcha). The form shows no case ID; Newfold mails one to the reporter
 * address, read as a reply and matched by our reference.
 */
export const newfoldProvider: ProviderSubmissionProvider = {
	definition: NEWFOLD_PROVIDER,
	prepareSubmission: (context) => prepareNewfoldSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "newfold_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => {
		const domain = normalizeDomain(context.target);
		const urls = domain ? newfoldReportUrls(domain, context.observedUrls) : [];
		return domain && urls.length > 0 ? makeNewfoldComments({
			target: domain,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: "PS-000000000000-R0",
			brand: NEWFOLD_PROVIDER.defaultBrand,
		}, urls) : undefined;
	},
	prepareExternalSubmission: (context) => prepareNewfoldExternalSubmission(context),
	// The executor always calls submitPrepared: the page and captcha token live in the preflight's browser session.
	submit: (context) => submitNewfoldSubmission(context, undefined),
	submitPrepared: (context, preflight) => submitNewfoldSubmission(context, preflight),
	inboundMail: {
		// The confirmation mail's sender is not documented; Newfold's own and its brands' domains are the best guess.
		senderDomains: ["newfold.com", "bluehost.com", "hostgator.com", "web.com", "networksolutions.com", "register.com", "domain.com"],
		confirmationIds: reportReferencesIn,
		messageKind: "reply",
	},
};

export { NEWFOLD_PROVIDER } from "./definition";
