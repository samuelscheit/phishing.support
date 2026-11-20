import { isIP } from "node:net";
import { z } from "zod";

import { normalizePublicHost } from "../../security";
import { emailOriginFactLines, type EmailOrigin } from "../email_origin";
import type { ReportInput } from "../kit/draft";
import { field, payloadEnvelope, storedReader } from "../kit/stored";
import { composeFreeText, isReportUrl, providerNarrative, reportUrls, type UrlRules } from "../kit/text";
import { isReportReference } from "../report_reference";
import { MICROSOFT_PROVIDER } from "./definition";

const envelope = payloadEnvelope(MICROSOFT_PROVIDER, "microsoft_msrc_report_v1");
/** The form takes one URL per item and rejects whitespace and the list separators `,;|`. */
const URL_RULES: UrlRules = { maximumLength: MICROSOFT_PROVIDER.urlMaximumLength, maximum: MICROSOFT_PROVIDER.maximumUrls, forbidden: /[\s,;|]/ };
const validReference = (value: unknown): value is string => isReportReference(value, MICROSOFT_PROVIDER.referenceMaximumLength);

const common = {
	/** Our `PS-…-R…` reference, at the top of the notes. */
	reference: z.string().refine(validReference),
	urls: z.array(field.url(URL_RULES.maximumLength, 1, URL_RULES.forbidden)).max(MICROSOFT_PROVIDER.maximumUrls),
	notes: field.text(MICROSOFT_PROVIDER.notesMaximumLength),
};

/** The durable, secret-free draft: the form values the submission sends, besides the time of filing. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: z.string() }),
	report: z.discriminatedUnion("threatType", [
		/** A page (`URL`): the pages are `urls`. */
		z.object({
			...common,
			threatType: z.literal(MICROSOFT_PROVIDER.threatType),
			incidentType: z.string().refine((type) => (Object.values(MICROSOFT_PROVIDER.incidentTypes) as readonly string[]).includes(type)),
			urls: common.urls.min(1),
			sourceIp: z.undefined().optional(),
			observedAt: z.undefined().optional(),
		}),
		/** The address that sent a phishing email (`IP Address`): its links are in the notes. */
		z.object({
			...common,
			threatType: z.literal(MICROSOFT_PROVIDER.ipThreatType),
			incidentType: z.literal(MICROSOFT_PROVIDER.emailIncidentType),
			urls: common.urls.length(0),
			/** The sending address (the form's `ipAddressList[0].sourceIp`). */
			sourceIp: z.string().refine((ip) => isIP(ip) !== 0),
			/** When the email was sent (the hop's UTC time), ISO 8601. */
			observedAt: z.string().refine((at) => Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at),
		}),
	]),
}).refine((payload) => payload.report.threatType !== MICROSOFT_PROVIDER.ipThreatType || payload.report.sourceIp === payload.target.normalizedTarget);

export type MicrosoftSubmissionPayload = z.infer<typeof payloadSchema>;

export type MicrosoftReportInput = ReportInput & {
	/** Set when the target is the IP that sent the phishing email, which has no observed URL of its own. */
	emailOrigin?: EmailOrigin;
	/** Stands in for the email's time when no Received header states one. */
	capturedAt?: Date;
};

/** The observed URLs the form can hold, in order; the host's root when none is. */
export function microsoftReportUrls(target: string, observedUrls: readonly string[]): string[] | undefined {
	const host = normalizePublicHost(target);
	if (!host) return undefined;
	// An address that was never observed serving a page is not a site: no root URL is made up for it.
	const urls = reportUrls(host, observedUrls, { ...URL_RULES, rootFallback: !isIP(host) });
	return urls.length > 0 ? urls : undefined;
}

/**
 * The reference leads, so that anything Microsoft quotes names our route; the
 * request takes no files here, so the case page is where Microsoft finds the
 * screenshots. The narrative ends with the preservation request.
 */
export const makeMicrosoftNotes = (input: MicrosoftReportInput, urls: readonly string[]) => composeFreeText({
	provider: "microsoft",
	input,
	urls,
	limit: MICROSOFT_PROVIDER.notesMaximumLength,
	before: [`Reference: ${input.trackingId}`],
	hostingLimit: MICROSOFT_PROVIDER.hostingLineMaximumLength,
	narrative: { maximum: MICROSOFT_PROVIDER.narrativeMaximumLength },
});

/**
 * The notes for the address that sent a phishing email: the API's `Spam` takes
 * addresses only, so the links the email pushes go here, as many as fit.
 */
export function makeMicrosoftEmailNotes(input: MicrosoftReportInput, origin: EmailOrigin, capturedAt: Date): string | undefined {
	if (!isIP(input.target)) return undefined;
	const narrative = providerNarrative("microsoft", { ...input, observedUrls: origin.links, source: "email" }, MICROSOFT_PROVIDER.emailNarrativeMaximumLength);
	if (!narrative) return undefined;
	const maximum = MICROSOFT_PROVIDER.notesMaximumLength;
	const compose = (listed: readonly string[]) => [
		`Reference: ${input.trackingId}`,
		narrative,
		emailOriginFactLines(input.target, origin, capturedAt, MICROSOFT_PROVIDER.emailReceivedMaximumLength).join("\n"),
		listed.length ? `Phishing URLs in the email:\n${listed.map((url) => `- ${url}`).join("\n")}` : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part).join("\n\n");
	// A link that does not fit is skipped, not cut; a shorter one may still fit.
	const listed: string[] = [];
	for (const link of origin.links) if (isReportUrl(link, URL_RULES) && compose([...listed, link]).length <= maximum) listed.push(link);
	const notes = compose(listed);
	return notes.length <= maximum ? notes : undefined;
}

function buildMicrosoftEmailPayload(input: MicrosoftReportInput, target: string, origin: EmailOrigin): MicrosoftSubmissionPayload | undefined {
	if (!isIP(target)) return undefined;
	const observedAt = origin.received?.at ?? input.capturedAt ?? new Date();
	const notes = makeMicrosoftEmailNotes({ ...input, target }, origin, observedAt);
	if (!notes) return undefined;
	return {
		...envelope.stamp,
		target: { normalizedTarget: target },
		report: {
			threatType: MICROSOFT_PROVIDER.ipThreatType,
			incidentType: MICROSOFT_PROVIDER.emailIncidentType,
			urls: [],
			sourceIp: target,
			observedAt: observedAt.toISOString(),
			reference: input.trackingId,
			notes,
		},
	};
}

export function buildMicrosoftSubmissionPayload(input: MicrosoftReportInput): MicrosoftSubmissionPayload | undefined {
	const normalizedTarget = normalizePublicHost(input.target);
	if (!normalizedTarget || !validReference(input.trackingId)) return undefined;
	if (input.emailOrigin) return buildMicrosoftEmailPayload(input, normalizedTarget, input.emailOrigin);
	const urls = microsoftReportUrls(normalizedTarget, input.observedUrls);
	if (!urls) return undefined;
	const notes = makeMicrosoftNotes({ ...input, target: normalizedTarget }, urls);
	if (!notes) return undefined;
	return {
		...envelope.stamp,
		target: { normalizedTarget },
		report: {
			threatType: MICROSOFT_PROVIDER.threatType,
			incidentType: input.allegationCategory === "malware" ? MICROSOFT_PROVIDER.incidentTypes.malware : MICROSOFT_PROVIDER.incidentTypes.phishing,
			urls,
			reference: input.trackingId,
			notes,
		},
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedMicrosoftSubmissionPayload = storedReader(payloadSchema);

/** The observation's date and time, as the form wants them: the time of filing, in UTC (`yyyy-MM-dd`, `HH:mm`, offset `+0000`). */
export function microsoftObservationTime(now: Date): { date: string; time: string; timeZone: string } {
	const iso = now.toISOString();
	return { date: iso.slice(0, 10), time: iso.slice(11, 16), timeZone: "+0000" };
}

/**
 * The request body the portal posts. The incident time of an email is when it
 * was sent, never later than the time of filing (the form refuses the future).
 */
export function microsoftRequestBody(payload: MicrosoftSubmissionPayload, now: Date) {
	const { report } = payload;
	const common = {
		source: MICROSOFT_PROVIDER.source,
		reporterName: MICROSOFT_PROVIDER.reporter.name,
		reporterEmail: MICROSOFT_PROVIDER.reporter.email,
		reporterOrg: MICROSOFT_PROVIDER.reporter.organization,
		phoneNumber: MICROSOFT_PROVIDER.reporter.phoneNumber,
	};
	if (report.threatType === MICROSOFT_PROVIDER.ipThreatType) {
		const sent = new Date(report.observedAt ?? now);
		return {
			threatType: report.threatType,
			...common,
			incidentType: report.incidentType,
			ipAddressList: [{ sourceIp: report.sourceIp }],
			reportNotes: report.notes,
			...microsoftObservationTime(sent < now ? sent : now),
			anonymizeReport: false,
		};
	}
	return {
		threatType: report.threatType,
		...common,
		incidentType: report.incidentType,
		urlList: report.urls.map((sourceUrl) => ({ sourceUrl })),
		reportNotes: report.notes,
		...microsoftObservationTime(now),
		anonymizeReport: false,
	};
}
