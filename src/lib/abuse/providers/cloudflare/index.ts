import type { ProviderSubmissionProvider } from "../submission_contracts";

import { CLOUDFLARE_PROVIDER } from "./definition";
import {
	prepareCloudflareExternalSubmission,
	prepareCloudflareSubmission,
	submitCloudflareSubmission,
} from "./submission";
import { buildCloudflareReportPreview } from "./form";

/** The sole executable owner of Cloudflare's abuse-form contract. */
export const cloudflareProvider: ProviderSubmissionProvider = {
	definition: CLOUDFLARE_PROVIDER,
	prepareSubmission: prepareCloudflareSubmission,
	shouldRefreshStartingPayload: (context) => context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: buildCloudflareReportPreview,
	prepareExternalSubmission: prepareCloudflareExternalSubmission,
	submit: submitCloudflareSubmission,
	submitPrepared: submitCloudflareSubmission,
};

export { CLOUDFLARE_PROVIDER } from "./definition";
export { buildCloudflareFormPayload } from "./form";
export { buildCloudflareReportPreview } from "./form";
