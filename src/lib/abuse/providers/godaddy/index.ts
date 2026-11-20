import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { normalizeDomain } from "../../security";
import { reportReferencesIn } from "../report_reference";
import { fetchGoDaddyCorrespondence, GODADDY_REVIEW_VERDICTS } from "./correspondence";
import { GODADDY_PROVIDER } from "./definition";
import { goDaddyReportUrls, makeGoDaddyInfo } from "./payload";
import { prepareGoDaddyExternalSubmission, prepareGoDaddySubmission, submitGoDaddySubmission } from "./submission";

/** GoDaddy's case ids (`DCU…`) as its mail and API write them. */
export function goDaddyConfirmationIds(text: string): string[] {
	const cases = [...text.matchAll(new RegExp(`\\b${GODADDY_PROVIDER.portal.casePattern}\\b`, "gi"))].map((match) => match[0].toUpperCase());
	return [...new Set([...reportReferencesIn(text), ...cases])];
}

/**
 * GoDaddy's abuse mailbox is unmonitored. The route files through the Abuse
 * API when GoDaddy enabled the reporter, else through the Legal Portal form.
 * The portal's case id arrives by mail; the mail is read as a reply and
 * matched by our reference or its case id, which then serves the public case
 * lookup.
 */
export const goDaddyProvider: ProviderSubmissionProvider = {
	definition: GODADDY_PROVIDER,
	prepareSubmission: (context) => prepareGoDaddySubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "godaddy_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => {
		const domain = normalizeDomain(context.target);
		const urls = domain ? goDaddyReportUrls(domain, context.observedUrls) : [];
		return domain && urls.length > 0 ? makeGoDaddyInfo({
			target: domain,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: "PS-000000000000-R0",
		}, urls) : undefined;
	},
	prepareExternalSubmission: (context) => prepareGoDaddyExternalSubmission(context),
	// The executor always calls submitPrepared: the channel, token and page live in the preflight.
	submit: (context) => submitGoDaddySubmission(context, undefined),
	submitPrepared: (context, preflight) => submitGoDaddySubmission(context, preflight),
	fetchCorrespondence: (context) => fetchGoDaddyCorrespondence(context),
	reviewVerdicts: GODADDY_REVIEW_VERDICTS,
	inboundMail: {
		senderDomains: ["godaddy.com"],
		confirmationIds: goDaddyConfirmationIds,
		messageKind: "reply",
	},
};

export { GODADDY_PROVIDER } from "./definition";
