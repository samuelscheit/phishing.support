import { defineProvider, registrarPreview } from "../kit/provider";
import { NEWFOLD_PROVIDER } from "./definition";
import { makeNewfoldComments, newfoldReportUrls } from "./payload";
import { prepareNewfoldExternalSubmission, prepareNewfoldSubmission, submitNewfoldSubmission } from "./submission";

/**
 * Newfold's abuse mailboxes are not monitored; the route files the report
 * through newfold.com/abuse from a real Chrome (reCAPTCHA solved through Death
 * by Captcha). The form shows no case ID; Newfold mails one to the reporter
 * address, read as a reply and matched by our reference.
 */
export const newfoldProvider = defineProvider({
	definition: NEWFOLD_PROVIDER,
	prepare: (context) => prepareNewfoldSubmission(context),
	preview: registrarPreview({ urls: newfoldReportUrls, make: makeNewfoldComments }),
	external: { prepare: (context) => prepareNewfoldExternalSubmission(context), submit: submitNewfoldSubmission },
	// The confirmation mail's sender is not documented; Newfold's own and its brands' domains are the best guess.
	inbound: { messageKind: "reply", senderDomains: ["newfold.com", "bluehost.com", "hostgator.com", "web.com", "networksolutions.com", "register.com", "domain.com"] },
});
