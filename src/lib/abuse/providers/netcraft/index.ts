import { defineProvider } from "../kit/provider";
import { NETCRAFT_PROVIDER } from "./definition";
import { prepareNetcraftSubmission, submitNetcraftSubmission } from "./submission";
import { makeNetcraftReason } from "./payload";
import { NETCRAFT_INBOUND_MAIL } from "./inbound";
import { fetchNetcraftCorrespondence, NETCRAFT_REVIEW_VERDICTS } from "./correspondence";

/** Supplemental Netcraft route for every report with one or more observed URLs. */
export const netcraftProvider = defineProvider({
	definition: NETCRAFT_PROVIDER,
	prepare: prepareNetcraftSubmission,
	preview: (context) => makeNetcraftReason({
		target: context.target,
		observedUrls: context.observedUrls,
		description: context.description,
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	inbound: NETCRAFT_INBOUND_MAIL,
	submit: (context) => submitNetcraftSubmission(context),
	fetchCorrespondence: (context) => fetchNetcraftCorrespondence(context),
	reviewVerdicts: NETCRAFT_REVIEW_VERDICTS,
});
