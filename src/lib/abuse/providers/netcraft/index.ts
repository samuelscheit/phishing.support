import { defineProvider } from "../kit/provider";
import { NETCRAFT_PROVIDER } from "./definition";
import { netcraftDraft, submitNetcraftSubmission } from "./submission";
import { makeNetcraftReason, storedNetcraftSubmissionPayload } from "./payload";
import { reportAccess } from "../kit/report_payload";
import { NETCRAFT_INBOUND_MAIL, netcraftDecision } from "./inbound";
import { fetchNetcraftCorrespondence, NETCRAFT_REVIEW_VERDICTS } from "./correspondence";

/** Supplemental Netcraft route for every report with one or more observed URLs. */
export const netcraftProvider = defineProvider({
	definition: NETCRAFT_PROVIDER,
	draft: netcraftDraft,
	preview: (context) => makeNetcraftReason({
		target: context.target,
		observedUrls: context.observedUrls,
		description: context.description,
		...reportAccess(context),
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
		...(context.legalBrandUrl ? { legalBrandUrl: context.legalBrandUrl } : {}),
	}),
	inbound: NETCRAFT_INBOUND_MAIL,
	submit: submitNetcraftSubmission,
	reportedUrls: (payload) => storedNetcraftSubmissionPayload(payload)?.target.observedUrls ?? [],
	fetchCorrespondence: fetchNetcraftCorrespondence,
	reviewVerdicts: NETCRAFT_REVIEW_VERDICTS,
	decisionOf: netcraftDecision,
	channel: "reporting API",
});
