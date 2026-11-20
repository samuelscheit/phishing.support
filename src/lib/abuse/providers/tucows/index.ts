import { defineProvider, PREVIEW_REFERENCE } from "../kit/provider";
import { TUCOWS_PROVIDER } from "./definition";
import { makeTucowsDescription, tucowsBrand, tucowsReportUrls } from "./payload";
import { prepareTucowsExternalSubmission, prepareTucowsSubmission, submitTucowsSubmission } from "./submission";

/**
 * Tucows (and its Enom brand) no longer read their abuse mailboxes; the route
 * files through Tucows' web form, behind a Turnstile token and a mailed code.
 * Its Freshdesk case mail goes to the service mailbox and quotes our reference,
 * so it is read as a reply: it can ask for more.
 */
export const tucowsProvider = defineProvider({
	definition: TUCOWS_PROVIDER,
	prepare: (context) => prepareTucowsSubmission(context),
	preview: (context) => {
		const urls = tucowsReportUrls(context.target, context.observedUrls);
		if (urls.length === 0 || context.allegationCategory === "malware" || !tucowsBrand(context.description, context.legalBrandUrl)) return undefined;
		return makeTucowsDescription({
			target: context.target,
			observedUrls: context.observedUrls,
			description: context.description,
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: PREVIEW_REFERENCE,
		}, urls);
	},
	external: { prepare: (context) => prepareTucowsExternalSubmission(context), submit: submitTucowsSubmission },
	// Case acknowledgements from Tucows' Freshdesk desk.
	inbound: { messageKind: "reply", senderDomains: ["tucows.com"] },
});
