import type { ProviderSubmissionProvider } from "../submission_contracts";
import { TENCENT_PROVIDER } from "./definition";
import { prepareTencentSubmission, submitTencentSubmission } from "./submission";

/** Tencent owns its DNS-abuse mailbox selection, evidence rules, and HTTP form. */
export const tencentProvider: ProviderSubmissionProvider = {
	definition: TENCENT_PROVIDER,
	prepareSubmission: prepareTencentSubmission,
	submit: submitTencentSubmission,
};

export { TENCENT_PROVIDER } from "./definition";
