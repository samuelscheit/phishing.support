import type { AbuseArtifact } from "../../schema";
import { normalizePublicHost, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
import {
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import { buildProviderReportNarrative, extractedBrandName, normalizeObservedUrlForTarget, truncateProviderText } from "../report_payload";
import { isReportReference } from "../report_reference";
import { TUCOWS_PROVIDER } from "./definition";

export const TUCOWS_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: TUCOWS_PROVIDER.evidence.acceptedMimeTypes,
	maximumBytes: TUCOWS_PROVIDER.evidence.maximumBytes,
	filenamePrefix: "tucows_report",
} as const satisfies ProviderEvidenceImageContract;

export type TucowsEvidenceReference = ProviderEvidenceImageReference<(typeof TUCOWS_PROVIDER.evidence.acceptedMimeTypes)[number]>;

/** The durable, secret-free draft: the form values the submission sends. */
export type TucowsSubmissionPayload = {
	adapter: "tucows_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { normalizedTarget: string };
	report: {
		reference: string;
		/** The form's "Offending domain name". */
		offendingDomain: string;
		/** "Brand Group" and "Brand domain": who is impersonated. */
		brandName: string;
		brandDomain: string;
		/** "URL of page with offending content". */
		url: string;
		/** "Your message". */
		description: string;
	};
	evidence: TucowsEvidenceReference;
};

export type TucowsReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
	/** Our reference, which leads the message so that Tucows' case mail quotes it. */
	reference: string;
	caseUrl?: string;
	/** `hostingAddressLine` of the route, when present. */
	hostingLine?: string;
	evidence: TucowsEvidenceReference;
};

export function selectTucowsEvidenceArtifact(artifacts: readonly AbuseArtifact[]): TucowsEvidenceReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, TUCOWS_EVIDENCE_CONTRACT);
}

/** The field is `type=url` with the pattern `https?://.+`. */
function validUrl(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 2_048 && !/\s/.test(value) && normalizePublicHttpUrl(value) === value;
}

/** The first observed URL of the target; the host's root when none is usable. */
export function tucowsReportUrls(target: string, observedUrls: readonly string[]): string[] {
	const urls = [...new Set(observedUrls.map((value) => normalizeObservedUrlForTarget(value, target)).filter((url): url is string => !!url && validUrl(url)))];
	if (urls.length > 0) return urls;
	const root = normalizePublicHttpUrl(`https://${target.includes(":") ? `[${target}]` : target}/`);
	return root && validUrl(root) ? [root] : [];
}

/** The impersonated brand: a label the analysis names, else the brand domain's own name. */
export function tucowsBrand(description: string, legalBrandUrl: string | null | undefined): { name: string; domain: string } | undefined {
	const brandUrl = legalBrandUrl ? normalizePublicHttpUrl(legalBrandUrl, { domainOnly: true }) : undefined;
	if (!brandUrl) return undefined;
	const domain = new URL(brandUrl).hostname.replace(/^www\./, "");
	const labels = domain.split(".");
	const label = labels.length > 1 ? labels[labels.length - 2]! : domain;
	return { name: extractedBrandName(description) ?? `${label.charAt(0).toUpperCase()}${label.slice(1)}`, domain };
}

/**
 * The message: our reference first, then the report narrative, the hosting
 * line and the case page that holds the full evidence.
 */
export function makeTucowsDescription(input: Omit<TucowsReportInput, "evidence">, urls: readonly string[]): string | undefined {
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const narrative = buildProviderReportNarrative({
		provider: "tucows",
		target: input.target,
		observedUrls: urls,
		description: input.description,
		allegationCategory: "phishing",
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		maximumLength: TUCOWS_PROVIDER.narrativeMaximumLength,
	});
	if (!narrative) return undefined;
	const message = [
		`Reference: ${input.reference}`,
		narrative,
		input.hostingLine ? truncateProviderText(input.hostingLine, 600) : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part).join("\n\n");
	return message.length <= TUCOWS_PROVIDER.maximumDescriptionLength ? message : undefined;
}

/** The draft, or undefined when the report cannot be filed here: a non-phishing allegation, no brand, no usable URL. */
export function buildTucowsSubmissionPayload(input: TucowsReportInput): TucowsSubmissionPayload | undefined {
	const target = normalizePublicHost(input.target);
	if (!target || input.allegationCategory === "malware" || !isReportReference(input.reference, 80)) return undefined;
	if (!storedProviderEvidenceImageReference(input.evidence, TUCOWS_EVIDENCE_CONTRACT)) return undefined;
	const urls = tucowsReportUrls(target, input.observedUrls);
	const brand = tucowsBrand(input.description, input.legalBrandUrl);
	if (urls.length === 0 || !brand) return undefined;
	const description = makeTucowsDescription({ ...input, target }, urls);
	if (!description) return undefined;
	return {
		adapter: "tucows_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: TUCOWS_PROVIDER.version, contentHash: TUCOWS_PROVIDER.contentHash },
		target: { normalizedTarget: target },
		report: { reference: input.reference, offendingDomain: target, brandName: brand.name, brandDomain: brand.domain, url: urls[0]!, description },
		evidence: input.evidence,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export function storedTucowsSubmissionPayload(value: unknown): TucowsSubmissionPayload | undefined {
	const payload = asRecord(value);
	const definition = asRecord(payload?.definition);
	const target = asRecord(payload?.target);
	const report = asRecord(payload?.report);
	if (!payload || payload.adapter !== "tucows_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== TUCOWS_PROVIDER.version || definition.contentHash !== TUCOWS_PROVIDER.contentHash
		|| typeof target?.normalizedTarget !== "string" || !report
		|| !isReportReference(report.reference, 80)
		|| typeof report.offendingDomain !== "string" || !report.offendingDomain
		|| typeof report.brandName !== "string" || !report.brandName || typeof report.brandDomain !== "string" || !report.brandDomain
		|| !validUrl(report.url)
		|| typeof report.description !== "string" || !report.description || report.description.length > TUCOWS_PROVIDER.maximumDescriptionLength) return undefined;
	const evidence = storedProviderEvidenceImageReference(payload.evidence, TUCOWS_EVIDENCE_CONTRACT);
	if (!evidence) return undefined;
	return {
		adapter: "tucows_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: TUCOWS_PROVIDER.version, contentHash: TUCOWS_PROVIDER.contentHash },
		target: { normalizedTarget: target.normalizedTarget },
		report: { reference: report.reference, offendingDomain: report.offendingDomain, brandName: report.brandName, brandDomain: report.brandDomain, url: report.url, description: report.description },
		evidence,
	};
}
