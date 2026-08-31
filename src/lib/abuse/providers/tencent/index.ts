import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { TENCENT_PROVIDER } from "./definition";
import { prepareTencentSubmission, submitTencentSubmission } from "./submission";
import { makeTencentExplanation } from "./payload";

/** Tencent owns its DNS-abuse mailbox selection, evidence rules, and HTTP form. */
export const tencentProvider: ProviderSubmissionProvider = {
	definition: TENCENT_PROVIDER,
	prepareSubmission: prepareTencentSubmission,
	shouldRefreshStartingPayload: (context) => context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => makeTencentExplanation({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	submit: submitTencentSubmission,
};

export { TENCENT_PROVIDER } from "./definition";
