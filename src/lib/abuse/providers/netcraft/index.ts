import type { ProviderSubmissionProvider } from "../submission_contracts";
import { NETCRAFT_PROVIDER } from "./definition";
import { prepareNetcraftSubmission, submitNetcraftSubmission } from "./submission";

/** Supplemental Netcraft route for every report with one or more observed URLs. */
export const netcraftProvider: ProviderSubmissionProvider = {
	definition: NETCRAFT_PROVIDER,
	prepareSubmission: prepareNetcraftSubmission,
	submit: submitNetcraftSubmission,
};

export { NETCRAFT_PROVIDER } from "./definition";
