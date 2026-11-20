import { defineProvider, registrarPreview } from "../kit/provider";
import { PUBLIC_DOMAIN_REGISTRY_PROVIDER } from "./definition";
import { makePublicDomainRegistryComplaint, publicDomainRegistryReportUrls } from "./payload";
import {
	preparePublicDomainRegistryExternalSubmission,
	publicDomainRegistryDraft,
	submitPublicDomainRegistrySubmission,
} from "./submission";

/**
 * PDR's abuse mailboxes are not monitored (the auto-reply says no action is
 * taken until the online form is used); the route files the report through
 * its phishing form from a real Chrome. PDR then mails a ticket number to the
 * reporter address; the mail is read as a reply and matched by our reference.
 */
export const publicDomainRegistryProvider = defineProvider({
	definition: PUBLIC_DOMAIN_REGISTRY_PROVIDER,
	draft: publicDomainRegistryDraft,
	preview: registrarPreview({ urls: publicDomainRegistryReportUrls, make: makePublicDomainRegistryComplaint }),
	external: { prepare: (context) => preparePublicDomainRegistryExternalSubmission(context), submit: submitPublicDomainRegistrySubmission },
	// PDR's ticket mail's sender is not documented; the site's own domain is the best guess.
	inbound: { messageKind: "reply", senderDomains: ["publicdomainregistry.com"] },
});
