import type { AbuseArtifact } from "../../schema";
import { normalizeDomain, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
import {
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget, truncateProviderText } from "../report_payload";
import { isReportReference } from "../report_reference";
import { NAME_COM_PROVIDER as PROVIDER } from "./definition";

export const NAME_COM_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: PROVIDER.evidence.acceptedMimeTypes,
	maximumBytes: PROVIDER.evidence.maximumBytes,
	filenamePrefix: "name_com_report",
} as const satisfies ProviderEvidenceImageContract;

export type NameComEvidenceReference = ProviderEvidenceImageReference<(typeof PROVIDER.evidence.acceptedMimeTypes)[number]>;

/** The durable, secret-free draft: the form values the submission sends, besides the page's own fields, its Turnstile token and the uploaded file's path. */
export type NameComSubmissionPayload = {
	adapter: "name_com_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { domain: string };
	report: {
		/** The reference Name.com's ticket mail quotes. */
		trackingId: string;
		additional: string;
	};
	/** The screenshot the form takes as an attachment, when the report has one. */
	evidence: NameComEvidenceReference | null;
};

export type NameComReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
	trackingId: string;
	caseUrl?: string;
	/** `hostingAddressLine` of the route, when the target resolved to a hoster's address. */
	hostingLine?: string;
	evidence?: NameComEvidenceReference | null;
};

function validUrl(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= PROVIDER.urlMaximumLength && !/\s/.test(value) && normalizePublicHttpUrl(value) === value;
}

/** The observed URLs of the domain, in order, that the additional's URL block can hold. */
export function nameComReportUrls(domain: string, observedUrls: readonly string[]): string[] {
	const urls: string[] = [];
	let length = 0;
	for (const value of observedUrls) {
		const url = normalizeObservedUrlForTarget(value, domain);
		if (!url || !validUrl(url) || urls.includes(url)) continue;
		// Each line costs its newline and "- ".
		if (urls.length >= PROVIDER.maximumUrls || length + url.length + 3 > PROVIDER.urlsMaximumLength) continue;
		urls.push(url);
		length += url.length + 3;
	}
	if (urls.length > 0) return urls;
	const root = normalizePublicHttpUrl(`https://${domain}/`);
	return root && validUrl(root) ? [root] : [];
}

/**
 * The form's "Additional Information" takes links and the narrative together, at
 * most 2000 characters (our limit; the form has none). The reference leads so the ticket mail quotes it;
 * the narrative gets what the other parts leave.
 */
export function makeNameComAdditional(input: NameComReportInput, urls: readonly string[]): string | undefined {
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const before = [`Reference: ${input.trackingId}`, `Reported URLs:\n${urls.map((url) => `- ${url}`).join("\n")}`];
	const after = [
		input.hostingLine ? truncateProviderText(input.hostingLine, PROVIDER.hostingLineMaximumLength) : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part);
	const room = PROVIDER.additionalMaximumLength - [...before, ...after].reduce((sum, part) => sum + part.length, 0) - 2 * (before.length + after.length + 1);
	if (room < PROVIDER.narrativeMinimumLength) return undefined;
	const narrative = buildProviderReportNarrative({
		provider: "name_com",
		target: input.target,
		observedUrls: urls,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		maximumLength: room,
	});
	if (!narrative) return undefined;
	const additional = [...before, narrative, ...after].join("\n\n");
	return additional.length <= PROVIDER.additionalMaximumLength ? additional : undefined;
}

export function selectNameComEvidenceArtifact(artifacts: readonly AbuseArtifact[]): NameComEvidenceReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, NAME_COM_EVIDENCE_CONTRACT);
}

export function buildNameComSubmissionPayload(input: NameComReportInput): NameComSubmissionPayload | undefined {
	const domain = normalizeDomain(input.target);
	if (!domain || !isReportReference(input.trackingId)) return undefined;
	const urls = nameComReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const additional = makeNameComAdditional({ ...input, target: domain }, urls);
	if (!additional) return undefined;
	return {
		adapter: "name_com_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: PROVIDER.version, contentHash: PROVIDER.contentHash },
		target: { domain },
		report: { trackingId: input.trackingId, additional },
		evidence: input.evidence ?? null,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export function storedNameComSubmissionPayload(value: unknown): NameComSubmissionPayload | undefined {
	const payload = asRecord(value);
	const definition = asRecord(payload?.definition);
	const target = asRecord(payload?.target);
	const report = asRecord(payload?.report);
	if (!payload || payload.adapter !== "name_com_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== PROVIDER.version || definition.contentHash !== PROVIDER.contentHash
		|| typeof target?.domain !== "string" || normalizeDomain(target.domain) !== target.domain
		|| !report || !isReportReference(report.trackingId)
		|| typeof report.additional !== "string" || report.additional.length === 0 || report.additional.length > PROVIDER.additionalMaximumLength
		|| !report.additional.startsWith(`Reference: ${report.trackingId}\n`)) return undefined;
	const evidence = payload.evidence === null ? null : storedProviderEvidenceImageReference(payload.evidence, NAME_COM_EVIDENCE_CONTRACT);
	if (evidence === undefined) return undefined;
	return {
		adapter: "name_com_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: PROVIDER.version, contentHash: PROVIDER.contentHash },
		target: { domain: target.domain },
		report: { trackingId: report.trackingId, additional: report.additional },
		evidence,
	};
}
