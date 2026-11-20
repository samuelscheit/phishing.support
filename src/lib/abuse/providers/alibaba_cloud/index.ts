import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import { makeAlibabaCloudReportReason } from "./payload";
import {
	fetchAlibabaCloudCorrespondence,
	findAlibabaCloudSubmission,
	prepareAlibabaCloudExternalSubmission,
	prepareAlibabaCloudSubmission,
	submitAlibabaCloudSubmission,
} from "./submission";

/**
 * Alibaba Cloud's abuse mailboxes are its fallback for reporters who cannot
 * log in; the route files the report in the Reporting Center with the
 * service's own Alibaba Cloud account instead.
 */
export const alibabaCloudProvider: ProviderSubmissionProvider = {
	definition: ALIBABA_CLOUD_PROVIDER,
	prepareSubmission: (context) => prepareAlibabaCloudSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "alibaba_cloud_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => makeAlibabaCloudReportReason({
		target: context.target,
		observedUrls: context.observedUrls,
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		legalBrandUrl: context.legalBrandUrl ?? null,
	}),
	prepareExternalSubmission: (context) => prepareAlibabaCloudExternalSubmission(context),
	submit: () => Promise.reject(new Error("Alibaba Cloud submits only from its prepared state.")),
	submitPrepared: (context, preflight) => submitAlibabaCloudSubmission(context, preflight),
	findSubmission: (context) => findAlibabaCloudSubmission(context),
	fetchCorrespondence: (context) => fetchAlibabaCloudCorrespondence(context),
	reviewVerdicts: {
		Valid: "acknowledged",
		"Notify rectification": "acknowledged",
		Completed: "acknowledged",
		"Supplementary information": "needs_more_information",
		Invalid: "rejected",
		Abnormal: "rejected",
	},
};

export { ALIBABA_CLOUD_PROVIDER } from "./definition";
