import { isIP } from "node:net";

import { normalizePublicHost, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
import { emailOriginFactLines, type EmailOrigin } from "../email_origin";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget, truncateProviderText } from "../report_payload";
import { isReportReference } from "../report_reference";
import { MICROSOFT_PROVIDER } from "./definition";

/** The durable, secret-free draft: the form values the submission sends, besides the time of filing. */
export type MicrosoftSubmissionPayload = {
	adapter: "microsoft_msrc_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { normalizedTarget: string };
	report: {
		/** `URL` for a page; `IP Address` for the address that sent a phishing email. */
		threatType: typeof MICROSOFT_PROVIDER.threatType | typeof MICROSOFT_PROVIDER.ipThreatType;
		incidentType: string;
		/** The pages; none for an email's sending address, whose links are in the notes. */
		urls: string[];
		/** `IP Address` only: the sending address (the form's `ipAddressList[0].sourceIp`). */
		sourceIp?: string;
		/** `IP Address` only: when the email was sent (the hop's UTC time), ISO 8601. */
		observedAt?: string;
		/** Our `PS-…-R…` reference, at the top of the notes. */
		reference: string;
		notes: string;
	};
};

export type MicrosoftReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
	reference: string;
	/** The page with the screenshots, since the request carries no files. */
	caseUrl?: string;
	/** `hostingAddressLine` of the route, when the target resolved to this hoster's address. */
	hostingLine?: string;
	/** Set when the target is the IP that sent the phishing email, which has no observed URL of its own. */
	emailOrigin?: EmailOrigin;
	/** Stands in for the email's time when no Received header states one. */
	capturedAt?: Date;
};

function validReference(value: unknown): value is string {
	return isReportReference(value, MICROSOFT_PROVIDER.referenceMaximumLength);
}

/** The form takes one URL per item and rejects whitespace and the list separators `,;|`. */
function validUrl(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MICROSOFT_PROVIDER.urlMaximumLength
		&& !/[\s,;|]/.test(value) && normalizePublicHttpUrl(value) === value;
}

/** The observed URLs the form can hold, in order; the host's root when none is. */
export function microsoftReportUrls(target: string, observedUrls: readonly string[]): string[] | undefined {
	const host = normalizePublicHost(target);
	if (!host) return undefined;
	const urls = new Set<string>();
	for (const value of observedUrls) {
		const url = normalizeObservedUrlForTarget(value, host);
		if (url && validUrl(url)) urls.add(url);
		if (urls.size >= MICROSOFT_PROVIDER.maximumUrls) break;
	}
	if (urls.size > 0) return [...urls];
	// An address that was never observed serving a page is not a site: no root URL is made up for it.
	if (isIP(host)) return undefined;
	const root = normalizePublicHttpUrl(`https://${host.includes(":") ? `[${host}]` : host}/`);
	return root && validUrl(root) ? [root] : undefined;
}

/**
 * The reference leads, so that anything Microsoft quotes names our route; the
 * request takes no files here, so the case page is where Microsoft finds the
 * screenshots. The narrative ends with the preservation request.
 */
export function makeMicrosoftNotes(input: MicrosoftReportInput, urls: readonly string[]): string | undefined {
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const narrative = buildProviderReportNarrative({
		provider: "microsoft",
		target: input.target,
		observedUrls: urls,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		maximumLength: MICROSOFT_PROVIDER.narrativeMaximumLength,
	});
	if (!narrative) return undefined;
	const notes = [
		`Reference: ${input.reference}`,
		narrative,
		input.hostingLine ? truncateProviderText(input.hostingLine, MICROSOFT_PROVIDER.hostingLineMaximumLength) : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part).join("\n\n");
	return notes.length <= MICROSOFT_PROVIDER.notesMaximumLength ? notes : undefined;
}

/**
 * The notes for the address that sent a phishing email: the API's `Spam` takes
 * addresses only, so the links the email pushes go here, as many as fit.
 */
export function makeMicrosoftEmailNotes(input: MicrosoftReportInput, origin: EmailOrigin, capturedAt: Date): string | undefined {
	if (!isIP(input.target)) return undefined;
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const narrative = buildProviderReportNarrative({
		provider: "microsoft",
		target: input.target,
		observedUrls: origin.links,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		source: "email",
		maximumLength: MICROSOFT_PROVIDER.emailNarrativeMaximumLength,
	});
	if (!narrative) return undefined;
	const maximum = MICROSOFT_PROVIDER.notesMaximumLength;
	const compose = (listed: readonly string[]) => [
		`Reference: ${input.reference}`,
		narrative,
		emailOriginFactLines(input.target, origin, capturedAt, MICROSOFT_PROVIDER.emailReceivedMaximumLength).join("\n"),
		listed.length ? `Phishing URLs in the email:\n${listed.map((url) => `- ${url}`).join("\n")}` : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part).join("\n\n");
	// A link that does not fit is skipped, not cut; a shorter one may still fit.
	const listed: string[] = [];
	for (const link of origin.links) if (validUrl(link) && compose([...listed, link]).length <= maximum) listed.push(link);
	const notes = compose(listed);
	return notes.length <= maximum ? notes : undefined;
}

function buildMicrosoftEmailPayload(input: MicrosoftReportInput, target: string, origin: EmailOrigin): MicrosoftSubmissionPayload | undefined {
	if (!isIP(target)) return undefined;
	const observedAt = origin.received?.at ?? input.capturedAt ?? new Date();
	const notes = makeMicrosoftEmailNotes({ ...input, target }, origin, observedAt);
	if (!notes) return undefined;
	return {
		adapter: "microsoft_msrc_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: MICROSOFT_PROVIDER.version, contentHash: MICROSOFT_PROVIDER.contentHash },
		target: { normalizedTarget: target },
		report: {
			threatType: MICROSOFT_PROVIDER.ipThreatType,
			incidentType: MICROSOFT_PROVIDER.emailIncidentType,
			urls: [],
			sourceIp: target,
			observedAt: observedAt.toISOString(),
			reference: input.reference,
			notes,
		},
	};
}

export function buildMicrosoftSubmissionPayload(input: MicrosoftReportInput): MicrosoftSubmissionPayload | undefined {
	const normalizedTarget = normalizePublicHost(input.target);
	if (!normalizedTarget || !validReference(input.reference)) return undefined;
	if (input.emailOrigin) return buildMicrosoftEmailPayload(input, normalizedTarget, input.emailOrigin);
	const urls = microsoftReportUrls(normalizedTarget, input.observedUrls);
	if (!urls) return undefined;
	const notes = makeMicrosoftNotes({ ...input, target: normalizedTarget }, urls);
	if (!notes) return undefined;
	return {
		adapter: "microsoft_msrc_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: MICROSOFT_PROVIDER.version, contentHash: MICROSOFT_PROVIDER.contentHash },
		target: { normalizedTarget },
		report: {
			threatType: MICROSOFT_PROVIDER.threatType,
			incidentType: input.allegationCategory === "malware" ? MICROSOFT_PROVIDER.incidentTypes.malware : MICROSOFT_PROVIDER.incidentTypes.phishing,
			urls,
			reference: input.reference,
			notes,
		},
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export function storedMicrosoftSubmissionPayload(value: unknown): MicrosoftSubmissionPayload | undefined {
	const payload = asRecord(value);
	const definition = asRecord(payload?.definition);
	const target = asRecord(payload?.target);
	const report = asRecord(payload?.report);
	if (!payload || payload.adapter !== "microsoft_msrc_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== MICROSOFT_PROVIDER.version || definition.contentHash !== MICROSOFT_PROVIDER.contentHash
		|| typeof target?.normalizedTarget !== "string" || !report || !validReference(report.reference)
		|| !Array.isArray(report.urls) || report.urls.length > MICROSOFT_PROVIDER.maximumUrls || !report.urls.every(validUrl)
		|| typeof report.notes !== "string" || report.notes.length === 0 || report.notes.length > MICROSOFT_PROVIDER.notesMaximumLength) return undefined;
	const base = {
		adapter: "microsoft_msrc_report_v1" as const,
		providerNarrativeVersion: 1 as const,
		definition: { version: MICROSOFT_PROVIDER.version, contentHash: MICROSOFT_PROVIDER.contentHash },
		target: { normalizedTarget: target.normalizedTarget },
	};
	const common = { reference: report.reference, notes: report.notes };
	const urls = [...report.urls as string[]];
	if (report.threatType === MICROSOFT_PROVIDER.ipThreatType) {
		const observedAt = report.observedAt;
		if (report.incidentType !== MICROSOFT_PROVIDER.emailIncidentType || urls.length !== 0 || report.sourceIp !== target.normalizedTarget || !isIP(report.sourceIp)
			|| typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) return undefined;
		return { ...base, report: { threatType: MICROSOFT_PROVIDER.ipThreatType, incidentType: MICROSOFT_PROVIDER.emailIncidentType, urls, sourceIp: report.sourceIp, observedAt, ...common } };
	}
	const incidentTypes: readonly unknown[] = Object.values(MICROSOFT_PROVIDER.incidentTypes);
	if (report.threatType !== MICROSOFT_PROVIDER.threatType || !incidentTypes.includes(report.incidentType) || urls.length === 0
		|| report.sourceIp !== undefined || report.observedAt !== undefined) return undefined;
	return { ...base, report: { threatType: MICROSOFT_PROVIDER.threatType, incidentType: report.incidentType as string, urls, ...common } };
}

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
