import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { reportReferencesIn } from "../report_reference";
import { NAME_COM_PROVIDER } from "./definition";
import { makeNameComAdditional, nameComReportUrls } from "./payload";
import { normalizeDomain } from "../../security";
import { prepareNameComExternalSubmission, prepareNameComSubmission, submitNameComSubmission } from "./submission";

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
export const nameComProvider: ProviderSubmissionProvider = {
	definition: NAME_COM_PROVIDER,
	prepareSubmission: (context) => prepareNameComSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "name_com_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => {
		const domain = normalizeDomain(context.target);
		const urls = domain ? nameComReportUrls(domain, context.observedUrls) : [];
		return domain && urls.length > 0 ? makeNameComAdditional({
			target: domain,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: "PS-000000000000-R0",
		}, urls) : undefined;
	},
	prepareExternalSubmission: (context) => prepareNameComExternalSubmission(context),
	// The executor always calls submitPrepared: the CSRF token and the page live in the preflight's browser session.
	submit: (context) => submitNameComSubmission(context, undefined),
	submitPrepared: (context, preflight) => submitNameComSubmission(context, preflight),
	inboundMail: {
		senderDomains: ["name.com"],
		confirmationIds: nameComConfirmationIds,
		messageKind: "reply",
	},
};

