import { defineProvider } from "../kit/provider";
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
export const alibabaCloudProvider = defineProvider({
	definition: ALIBABA_CLOUD_PROVIDER,
	prepare: prepareAlibabaCloudSubmission,
	preview: (context) => makeAlibabaCloudReportReason({
		target: context.target,
		observedUrls: context.observedUrls,
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		legalBrandUrl: context.legalBrandUrl ?? null,
	}),
	external: {
		prepare: (context) => prepareAlibabaCloudExternalSubmission(context),
		submit: async (context, preflight) => {
			if (!preflight) throw new Error("Alibaba Cloud submits only from its prepared state.");
			return submitAlibabaCloudSubmission(context, preflight);
		},
	},
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
});
