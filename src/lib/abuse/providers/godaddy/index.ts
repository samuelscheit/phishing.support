import { defineProvider, registrarPreview } from "../kit/provider";
import { reportReferencesIn } from "../report_reference";
import { fetchGoDaddyCorrespondence, GODADDY_REVIEW_VERDICTS } from "./correspondence";
import { GODADDY_PROVIDER } from "./definition";
import { goDaddyReportUrls, makeGoDaddyInfo } from "./payload";
import { prepareGoDaddyExternalSubmission, prepareGoDaddySubmission, submitGoDaddySubmission } from "./submission";

/** GoDaddy's case ids (`DCU…`) as its mail and API write them. */
export function goDaddyConfirmationIds(text: string): string[] {
	const cases = [...text.matchAll(new RegExp(`\\b${GODADDY_PROVIDER.portal.casePattern}\\b`, "gi"))].map((match) => match[0].toUpperCase());
	return [...new Set([...reportReferencesIn(text), ...cases])];
}

/**
 * GoDaddy's abuse mailbox is unmonitored. The route files through the Abuse
 * API when GoDaddy enabled the reporter, else through the Legal Portal form.
 * The portal's case id arrives by mail; the mail is read as a reply and
 * matched by our reference or its case id, which then serves the public case
 * lookup.
 */
export const goDaddyProvider = defineProvider({
	definition: GODADDY_PROVIDER,
	prepare: (context) => prepareGoDaddySubmission(context),
	preview: registrarPreview({ urls: goDaddyReportUrls, make: makeGoDaddyInfo }),
	external: { prepare: (context) => prepareGoDaddyExternalSubmission(context), submit: (context, preflight) => submitGoDaddySubmission(context, preflight) },
	fetchCorrespondence: (context) => fetchGoDaddyCorrespondence(context),
	reviewVerdicts: GODADDY_REVIEW_VERDICTS,
	inbound: { messageKind: "reply", senderDomains: ["godaddy.com"], confirmationIds: goDaddyConfirmationIds },
});
