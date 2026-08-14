import type { ProviderSubmissionProvider } from "../submission_contracts";
import { GOOGLE_SAFE_BROWSING_PROVIDER } from "./definition";
import { prepareGoogleSafeBrowsingSubmission, submitGoogleSafeBrowsingSubmission } from "./submission";

/** Supplemental Google route: it is independent from an infrastructure abuse mailbox. */
export const googleSafeBrowsingProvider: ProviderSubmissionProvider = {
	definition: GOOGLE_SAFE_BROWSING_PROVIDER,
	prepareSubmission: prepareGoogleSafeBrowsingSubmission,
	submit: submitGoogleSafeBrowsingSubmission,
};

export { GOOGLE_SAFE_BROWSING_PROVIDER } from "./definition";
