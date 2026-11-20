import { normalizePublicHost, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
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
		incidentType: string;
		urls: string[];
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

export function buildMicrosoftSubmissionPayload(input: MicrosoftReportInput): MicrosoftSubmissionPayload | undefined {
	const normalizedTarget = normalizePublicHost(input.target);
	const urls = normalizedTarget ? microsoftReportUrls(normalizedTarget, input.observedUrls) : undefined;
	if (!normalizedTarget || !urls || !validReference(input.reference)) return undefined;
	const notes = makeMicrosoftNotes({ ...input, target: normalizedTarget }, urls);
	if (!notes) return undefined;
	return {
		adapter: "microsoft_msrc_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: MICROSOFT_PROVIDER.version, contentHash: MICROSOFT_PROVIDER.contentHash },
		target: { normalizedTarget },
		report: {
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
	const incidentTypes: readonly unknown[] = Object.values(MICROSOFT_PROVIDER.incidentTypes);
	if (!payload || payload.adapter !== "microsoft_msrc_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== MICROSOFT_PROVIDER.version || definition.contentHash !== MICROSOFT_PROVIDER.contentHash
		|| typeof target?.normalizedTarget !== "string" || !report
		|| !incidentTypes.includes(report.incidentType) || !validReference(report.reference)
		|| !Array.isArray(report.urls) || report.urls.length === 0 || report.urls.length > MICROSOFT_PROVIDER.maximumUrls || !report.urls.every(validUrl)
		|| typeof report.notes !== "string" || report.notes.length === 0 || report.notes.length > MICROSOFT_PROVIDER.notesMaximumLength) return undefined;
	return {
		adapter: "microsoft_msrc_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: MICROSOFT_PROVIDER.version, contentHash: MICROSOFT_PROVIDER.contentHash },
		target: { normalizedTarget: target.normalizedTarget },
		report: { incidentType: report.incidentType as string, urls: [...report.urls as string[]], reference: report.reference, notes: report.notes },
	};
}

/** The observation's date and time, as the form wants them: the time of filing, in UTC (`yyyy-MM-dd`, `HH:mm`, offset `+0000`). */
export function microsoftObservationTime(now: Date): { date: string; time: string; timeZone: string } {
	const iso = now.toISOString();
	return { date: iso.slice(0, 10), time: iso.slice(11, 16), timeZone: "+0000" };
}

/** The request body the portal posts. */
export function microsoftRequestBody(payload: MicrosoftSubmissionPayload, now: Date) {
	return {
		threatType: MICROSOFT_PROVIDER.threatType,
		source: MICROSOFT_PROVIDER.source,
		incidentType: payload.report.incidentType,
		reporterName: MICROSOFT_PROVIDER.reporter.name,
		reporterEmail: MICROSOFT_PROVIDER.reporter.email,
		reporterOrg: MICROSOFT_PROVIDER.reporter.organization,
		phoneNumber: MICROSOFT_PROVIDER.reporter.phoneNumber,
		urlList: payload.report.urls.map((sourceUrl) => ({ sourceUrl })),
		reportNotes: payload.report.notes,
		...microsoftObservationTime(now),
		anonymizeReport: false,
	};
}
