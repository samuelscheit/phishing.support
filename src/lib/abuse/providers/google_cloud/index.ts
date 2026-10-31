import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { GOOGLE_CLOUD_PROVIDER } from "./definition";
import { makeGoogleCloudAbuseDetails } from "./payload";
import { prepareGoogleCloudSubmission, submitGoogleCloudSubmission } from "./submission";

/** Google Cloud's abuse mailboxes answer with this form; the route files the report there instead. */
export const googleCloudProvider: ProviderSubmissionProvider = {
	definition: GOOGLE_CLOUD_PROVIDER,
	prepareSubmission: prepareGoogleCloudSubmission,
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "google_cloud_abuse_report_v1"
		|| context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => makeGoogleCloudAbuseDetails({
		target: context.target,
		observedUrls: context.observedUrls,
		description: context.description,
		capturedAt: new Date(),
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	submit: (context) => submitGoogleCloudSubmission(context),
};

export { GOOGLE_CLOUD_PROVIDER } from "./definition";
