import { defineProvider, registrarPreview } from "../kit/provider";
import { reportReferencesIn } from "../report_reference";
import { NAME_COM_PROVIDER } from "./definition";
import { makeNameComAdditional, nameComReportUrls } from "./payload";
import { prepareNameComExternalSubmission, nameComDraft, submitNameComSubmission } from "./submission";

/** Zendesk's request mails name the ticket as "[Request #12345]". */
export function nameComConfirmationIds(text: string): string[] {
	return [...new Set([...reportReferencesIn(text), ...[...text.matchAll(/\brequest\s*#\s*(\d{3,12})\b/gi)].map((match) => match[1]!)])];
}

/**
 * abuse@name.com is not monitored; the route files the report through the
 * Report Abuse form from a real Chrome. The form's answer carries the Zendesk
 * case id, which becomes the confirmation id; Zendesk's mails to the reporter
 * address are read as replies, matched by that id or our reference.
 */
export const nameComProvider = defineProvider({
	definition: NAME_COM_PROVIDER,
	draft: nameComDraft,
	preview: registrarPreview({ urls: nameComReportUrls, make: makeNameComAdditional }),
	external: { prepare: (context) => prepareNameComExternalSubmission(context), submit: submitNameComSubmission },
	inbound: { messageKind: "reply", senderDomains: ["name.com"], confirmationIds: nameComConfirmationIds },
});
