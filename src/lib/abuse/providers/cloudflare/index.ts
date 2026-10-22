import type { ProviderSubmissionProvider } from "../submission_contracts";

import { CLOUDFLARE_PROVIDER } from "./definition";
import { buildCloudflareReportPreview } from "./report";
import { prepareCloudflareExternalSubmission, prepareCloudflareSubmission, submitCloudflareSubmission } from "./submission";

/** The sole executable owner of Cloudflare's authenticated abuse-report API contract. */
export const cloudflareProvider: ProviderSubmissionProvider = {
	definition: CLOUDFLARE_PROVIDER,
	prepareSubmission: (context) => prepareCloudflareSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "cloudflare_abuse_api_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: buildCloudflareReportPreview,
	prepareExternalSubmission: (context) => prepareCloudflareExternalSubmission(context),
	submit: (context) => submitCloudflareSubmission(context),
	submitPrepared: (context, preflight) => submitCloudflareSubmission(context, {}, preflight),
};

export { CLOUDFLARE_PROVIDER } from "./definition";
export { buildCloudflareReportPayload, buildCloudflareReportPreview } from "./report";
