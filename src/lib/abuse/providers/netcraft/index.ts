import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { NETCRAFT_PROVIDER } from "./definition";
import { prepareNetcraftSubmission, submitNetcraftSubmission } from "./submission";
import { makeNetcraftReason } from "./payload";
import { reconcileNetcraftProviderRun } from "./reconcile";

/** Supplemental Netcraft route for every report with one or more observed URLs. */
export const netcraftProvider: ProviderSubmissionProvider = {
	definition: NETCRAFT_PROVIDER,
	prepareSubmission: prepareNetcraftSubmission,
	shouldRefreshStartingPayload: (context) => context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => makeNetcraftReason({
		target: context.target,
		observedUrls: context.observedUrls,
		description: context.description,
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	submit: submitNetcraftSubmission,
};

export { NETCRAFT_PROVIDER } from "./definition";
export { reconcileNetcraftProviderRun } from "./reconcile";
