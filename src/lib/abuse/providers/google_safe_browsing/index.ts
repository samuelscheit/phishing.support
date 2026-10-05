import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { GOOGLE_SAFE_BROWSING_PROVIDER } from "./definition";
import { prepareGoogleSafeBrowsingSubmission, submitGoogleSafeBrowsingSubmission } from "./submission";
import { makeGoogleSafeBrowsingExplanation } from "./payload";

/** Supplemental Google route: it is independent from an infrastructure abuse mailbox. */
export const googleSafeBrowsingProvider: ProviderSubmissionProvider = {
	definition: GOOGLE_SAFE_BROWSING_PROVIDER,
	prepareSubmission: prepareGoogleSafeBrowsingSubmission,
	shouldRefreshStartingPayload: (context) => context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => makeGoogleSafeBrowsingExplanation({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	submit: submitGoogleSafeBrowsingSubmission,
};

export { GOOGLE_SAFE_BROWSING_PROVIDER } from "./definition";
