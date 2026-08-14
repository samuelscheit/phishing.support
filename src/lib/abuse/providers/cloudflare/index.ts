import type { ProviderSubmissionProvider } from "../submission_contracts";

import { CLOUDFLARE_PROVIDER } from "./definition";
import { prepareCloudflareSubmission, submitCloudflareSubmission } from "./submission";

/** The sole executable owner of Cloudflare's abuse-form contract. */
export const cloudflareProvider: ProviderSubmissionProvider = {
	definition: CLOUDFLARE_PROVIDER,
	prepareSubmission: prepareCloudflareSubmission,
	submit: submitCloudflareSubmission,
};

export { CLOUDFLARE_PROVIDER } from "./definition";
export { buildCloudflareFormPayload } from "./form";
