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
import { DYNADOT_PROVIDER as PROVIDER } from "./definition";

export const DYNADOT_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: PROVIDER.evidence.acceptedMimeTypes,
	maximumBytes: PROVIDER.evidence.maximumBytes,
	filenamePrefix: "dynadot_report",
} as const satisfies ProviderEvidenceImageContract;

export type DynadotEvidenceReference = ProviderEvidenceImageReference<(typeof PROVIDER.evidence.acceptedMimeTypes)[number]>;

/** The durable, secret-free draft: the form values the submission sends, besides its Turnstile token and the screenshot's bytes. */
export type DynadotSubmissionPayload = {
	adapter: "dynadot_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { domain: string };
	report: {
		/** The reference at the top of the comment; Dynadot's mail, if any, may quote it. */
		trackingId: string;
		/** "Full Domain Path": the reported URL the form takes one of. */
		domainPath: string;
		/** "Official Website": the impersonated brand's site, or N/A. */
		officialWebsite: string;
		comments: string;
	};
	/** The screenshot the form takes as an upload, when the report has one. */
	evidence: DynadotEvidenceReference | null;
};

export type DynadotReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
	trackingId: string;
	caseUrl?: string;
	/** `hostingAddressLine` of the route, when the target resolved to a hoster's address. */
	hostingLine?: string;
	evidence?: DynadotEvidenceReference | null;
};

function validUrl(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= PROVIDER.inputMaximumLength && !/\s/.test(value) && normalizePublicHttpUrl(value) === value;
}

/** The observed URLs of the domain, in order, that the form's inputs and the comment's URL block can hold; the first is the "Full Domain Path". */
export function dynadotReportUrls(domain: string, observedUrls: readonly string[]): string[] {
	const urls: string[] = [];
	let length = 0;
	for (const value of observedUrls) {
		const url = normalizeObservedUrlForTarget(value, domain);
		if (!url || !validUrl(url) || urls.includes(url)) continue;
		if (urls.length >= PROVIDER.maximumUrls || length + url.length + 3 > PROVIDER.urlsMaximumLength) continue;
		urls.push(url);
		length += url.length + 3;
	}
	if (urls.length > 0) return urls;
	const root = normalizePublicHttpUrl(`https://${domain}/`);
	return root && validUrl(root) ? [root] : [];
}

/** The impersonated brand's site for "Official Website", or "N/A" when the report names none that fits. */
export function dynadotOfficialWebsite(legalBrandUrl: string | null | undefined): string {
	const url = legalBrandUrl ? normalizePublicHttpUrl(legalBrandUrl, { domainOnly: true }) : undefined;
	return url && url.length <= PROVIDER.inputMaximumLength ? url : PROVIDER.notApplicable;
}

/**
 * The form's "Comments": the reference leads, then the URLs, the narrative,
 * the hosting line and the case page, within the comment's limit.
 */
export function makeDynadotComments(input: DynadotReportInput, urls: readonly string[]): string | undefined {
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const before = [`Reference: ${input.trackingId}`, `Reported URLs:\n${urls.map((url) => `- ${url}`).join("\n")}`];
	const after = [
		input.hostingLine ? truncateProviderText(input.hostingLine, PROVIDER.hostingLineMaximumLength) : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part);
	const room = PROVIDER.commentsMaximumLength - [...before, ...after].reduce((sum, part) => sum + part.length, 0) - 2 * (before.length + after.length + 1);
	if (room < PROVIDER.narrativeMinimumLength) return undefined;
	const narrative = buildProviderReportNarrative({
		provider: "dynadot",
		target: input.target,
		observedUrls: urls,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		maximumLength: room,
	});
	if (!narrative) return undefined;
	const comments = [...before, narrative, ...after].join("\n\n");
	return comments.length <= PROVIDER.commentsMaximumLength ? comments : undefined;
}

export function selectDynadotEvidenceArtifact(artifacts: readonly AbuseArtifact[]): DynadotEvidenceReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, DYNADOT_EVIDENCE_CONTRACT);
}

export function buildDynadotSubmissionPayload(input: DynadotReportInput): DynadotSubmissionPayload | undefined {
	const domain = normalizeDomain(input.target);
	if (!domain || !isReportReference(input.trackingId)) return undefined;
	const urls = dynadotReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const comments = makeDynadotComments({ ...input, target: domain }, urls);
	if (!comments) return undefined;
	return {
		adapter: "dynadot_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: PROVIDER.version, contentHash: PROVIDER.contentHash },
		target: { domain },
		report: { trackingId: input.trackingId, domainPath: urls[0]!, officialWebsite: dynadotOfficialWebsite(input.legalBrandUrl), comments },
		evidence: input.evidence ?? null,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export function storedDynadotSubmissionPayload(value: unknown): DynadotSubmissionPayload | undefined {
	const payload = asRecord(value);
	const definition = asRecord(payload?.definition);
	const target = asRecord(payload?.target);
	const report = asRecord(payload?.report);
	if (!payload || payload.adapter !== "dynadot_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== PROVIDER.version || definition.contentHash !== PROVIDER.contentHash
		|| typeof target?.domain !== "string" || normalizeDomain(target.domain) !== target.domain
		|| !report || !isReportReference(report.trackingId)
		|| !validUrl(report.domainPath)
		|| typeof report.officialWebsite !== "string" || report.officialWebsite.length === 0 || report.officialWebsite.length > PROVIDER.inputMaximumLength
		|| (report.officialWebsite !== PROVIDER.notApplicable && normalizePublicHttpUrl(report.officialWebsite, { domainOnly: true }) !== report.officialWebsite)
		|| typeof report.comments !== "string" || report.comments.length === 0 || report.comments.length > PROVIDER.commentsMaximumLength
		|| !report.comments.startsWith(`Reference: ${report.trackingId}\n`)) return undefined;
	const evidence = payload.evidence === null ? null : storedProviderEvidenceImageReference(payload.evidence, DYNADOT_EVIDENCE_CONTRACT);
	if (evidence === undefined) return undefined;
	return {
		adapter: "dynadot_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: PROVIDER.version, contentHash: PROVIDER.contentHash },
		target: { domain: target.domain },
		report: { trackingId: report.trackingId, domainPath: report.domainPath, officialWebsite: report.officialWebsite, comments: report.comments },
		evidence,
	};
}
