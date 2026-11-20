import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { reportReferencesIn } from "../report_reference";
import { PUBLIC_DOMAIN_REGISTRY_PROVIDER } from "./definition";
import { makePublicDomainRegistryComplaint, publicDomainRegistryReportUrls } from "./payload";
import { normalizeDomain } from "../../security";
import {
	preparePublicDomainRegistryExternalSubmission,
	preparePublicDomainRegistrySubmission,
	submitPublicDomainRegistrySubmission,
} from "./submission";

/**
 * PDR's abuse mailboxes are not monitored (the auto-reply says no action is
 * taken until the online form is used); the route files the report through
 * its phishing form from a real Chrome. PDR then mails a ticket number to the
 * reporter address; the mail is read as a reply and matched by our reference.
 */
export const publicDomainRegistryProvider: ProviderSubmissionProvider = {
	definition: PUBLIC_DOMAIN_REGISTRY_PROVIDER,
	prepareSubmission: (context) => preparePublicDomainRegistrySubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "publicdomainregistry_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => {
		const domain = normalizeDomain(context.target);
		const urls = domain ? publicDomainRegistryReportUrls(domain, context.observedUrls) : [];
		return domain && urls.length > 0 ? makePublicDomainRegistryComplaint({
			target: domain,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: "PS-000000000000-R0",
		}, urls) : undefined;
	},
	prepareExternalSubmission: (context) => preparePublicDomainRegistryExternalSubmission(context),
	// The executor always calls submitPrepared: the Turnstile token and the page live in the preflight's browser session.
	submit: (context) => submitPublicDomainRegistrySubmission(context, undefined),
	submitPrepared: (context, preflight) => submitPublicDomainRegistrySubmission(context, preflight),
	inboundMail: {
		// PDR's ticket mail's sender is not documented; the site's own domain is the best guess.
		senderDomains: ["publicdomainregistry.com"],
		confirmationIds: reportReferencesIn,
		messageKind: "reply",
	},
};

