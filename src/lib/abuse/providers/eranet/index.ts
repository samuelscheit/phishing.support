import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
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
};

export { ERANET_PROVIDER } from "./definition";
