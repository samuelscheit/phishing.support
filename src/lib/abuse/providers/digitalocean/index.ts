import { defineProvider, registrarPreview } from "../kit/provider";
import { DIGITALOCEAN_PROVIDER } from "./definition";
import { digitalOceanReportUrls, makeDigitalOceanDetails } from "./payload";
import { digitalOceanDraft, submitDigitalOceanSubmission } from "./submission";

/**
 * abuse@digitalocean.com processes only XARF reports and sends people to the
 * form, so the route files through the form; when the form refuses, the
 * mailbox gets the report as XARF (`emailFallback`). DigitalOcean's mail
 * about a report is read as a reply.
 */
export const digitalOceanProvider = defineProvider({
	definition: DIGITALOCEAN_PROVIDER,
	draft: digitalOceanDraft,
	preview: registrarPreview({ urls: digitalOceanReportUrls, make: makeDigitalOceanDetails }),
	submit: submitDigitalOceanSubmission,
	inbound: { messageKind: "reply", senderDomains: ["digitalocean.com"] },
});
