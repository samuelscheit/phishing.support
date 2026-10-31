import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { NAMESILO_PROVIDER } from "./definition";
import { makeNameSiloExplanation } from "./payload";
import {
	prepareNameSiloExternalSubmission,
	prepareNameSiloSubmission,
	submitNameSiloSubmission,
} from "./submission";

/** NameSilo owns its exact mailboxes, form contract, CSRF state, and upload. */
export const nameSiloProvider: ProviderSubmissionProvider = {
	definition: NAMESILO_PROVIDER,
	prepareSubmission: prepareNameSiloSubmission,
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "namesilo_phishing_report_v1"
		|| context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => makeNameSiloExplanation({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...(context.legalBrandUrl ? { realWebsite: context.legalBrandUrl } : {}),
	}),
	prepareExternalSubmission: prepareNameSiloExternalSubmission,
	// The executor always calls submitPrepared when preflight state exists.
	submit: (context) => submitNameSiloSubmission(context),
	submitPrepared: (context, preflight) => submitNameSiloSubmission(context, {}, preflight),
};

export { NAMESILO_PROVIDER } from "./definition";
