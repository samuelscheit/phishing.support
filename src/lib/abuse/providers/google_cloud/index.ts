import { defineProvider } from "../kit/provider";
import { GOOGLE_CLOUD_PROVIDER } from "./definition";
import { makeGoogleCloudAbuseDetails } from "./payload";
import { prepareGoogleCloudSubmission, submitGoogleCloudSubmission } from "./submission";

/** Google Cloud's abuse mailboxes answer with this form; the route files the report there instead. */
export const googleCloudProvider = defineProvider({
	definition: GOOGLE_CLOUD_PROVIDER,
	prepare: prepareGoogleCloudSubmission,
	preview: (context) => makeGoogleCloudAbuseDetails({
		target: context.target,
		observedUrls: context.observedUrls,
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		capturedAt: new Date(),
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	submit: (context) => submitGoogleCloudSubmission(context),
});
