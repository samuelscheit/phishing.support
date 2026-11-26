import { defineProvider } from "../kit/provider";
import { GNAME_PROVIDER } from "./definition";
import { makeGnameDescription } from "./payload";
import { reportAccess } from "../kit/report_payload";
import { gnameDraft, prepareGnameExternalSubmission, submitGnameSubmission } from "./submission";

/** GNAME (IANA 1923 and its sibling accreditations) takes abuse complaints through its own form, gated by a slider and a mailed code. */
export const gnameProvider = defineProvider({
	definition: GNAME_PROVIDER,
	draft: gnameDraft,
	preview: (context) => makeGnameDescription({
		target: context.target,
		observedUrl: context.observedUrls[0],
		description: context.description,
		...reportAccess(context),
		...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
	}),
	// The code lives in the preflight's browser session.
	external: { prepare: prepareGnameExternalSubmission, submit: submitGnameSubmission },
	// GNAME mails its case number when it receives and when it settles a complaint.
	inbound: {
		senderDomains: ["gname.com"],
		confirmationIds: (text) => [...new Set([...text.matchAll(/\bcase\s*(?:no\.?|number)\s*[:：]?\s*([A-Z0-9-]{6,40})\b/gi)].map((match) => match[1]!))],
	},
});
