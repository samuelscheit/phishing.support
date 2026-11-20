import { defineProvider, registrarPreview } from "../kit/provider";
import { DYNADOT_PROVIDER } from "./definition";
import { dynadotReportUrls, makeDynadotComments } from "./payload";
import { prepareDynadotExternalSubmission, prepareDynadotSubmission, submitDynadotSubmission } from "./submission";

/**
 * Dynadot's abuse mailbox is not monitored; the route files the report through
 * its abuse form from a real Chrome. The form shows no case id and promises no
 * reply, so any mail is read as a reply and matched by our reference.
 */
export const dynadotProvider = defineProvider({
	definition: DYNADOT_PROVIDER,
	prepare: (context) => prepareDynadotSubmission(context),
	preview: registrarPreview({ urls: dynadotReportUrls, make: makeDynadotComments }),
	external: { prepare: (context) => prepareDynadotExternalSubmission(context), submit: submitDynadotSubmission },
	inbound: { messageKind: "reply", senderDomains: ["dynadot.com"] },
});
