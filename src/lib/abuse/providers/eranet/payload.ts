import type { AbuseArtifact } from "../../schema";
import { normalizeDomain } from "../../security";
import { recordValue } from "../../worker/shared";
import {
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget } from "../report_payload";
import { ERANET_PROVIDER } from "./definition";

export const ERANET_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: ERANET_PROVIDER.evidence.acceptedMimeTypes,
	maximumBytes: ERANET_PROVIDER.evidence.maximumBytes,
	filenamePrefix: "eranet_report",
} as const satisfies ProviderEvidenceImageContract;

export type EranetEvidenceReference = ProviderEvidenceImageReference<(typeof ERANET_PROVIDER.evidence.acceptedMimeTypes)[number]>;

/** The form's report-type checkboxes this service files under. */
export type EranetSubType = "phishing_site" | "other";

export type EranetSubmissionPayload = {
	adapter: "eranet_phishing_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { domain: string; observedUrl: string };
	report: { subTypes: EranetSubType[]; description: string; website: string };
	evidence?: EranetEvidenceReference;
};

export function eranetSubTypes(allegationCategory: string | undefined): EranetSubType[] {
	return allegationCategory === "malware" ? ["other"] : ["phishing_site"];
}

export function makeEranetDescription(params: { target?: string; observedUrl?: string; description: string; allegationCategory?: string; legalBrandUrl?: string }): string | undefined {
	return buildProviderReportNarrative({
		provider: "eranet",
		target: params.target,
		observedUrls: params.observedUrl ? [params.observedUrl] : [],
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl ? { legalBrandUrl: params.legalBrandUrl } : {}),
		maximumLength: ERANET_PROVIDER.maximumDescriptionLength,
	});
}

export function selectEranetEvidenceArtifact(artifacts: readonly AbuseArtifact[]): EranetEvidenceReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, ERANET_EVIDENCE_CONTRACT);
}

/**
 * The durable, secret-free Eranet draft. The form's required "legitimate
 * website" field names the impersonated brand's site, or for malware (which
 * impersonates nothing) the case page that holds the evidence.
 */
export function buildEranetSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	allegationCategory?: string;
	website: string;
	legalBrandUrl?: string;
	evidence?: EranetEvidenceReference;
}): EranetSubmissionPayload | undefined {
	const domain = normalizeDomain(params.target);
	const observedUrl = domain ? normalizeObservedUrlForTarget(params.observedUrl, domain) : undefined;
	const description = makeEranetDescription({
		target: domain,
		observedUrl,
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl ? { legalBrandUrl: params.legalBrandUrl } : {}),
	});
	if (!domain || !observedUrl || !description || !params.website) return undefined;
	return {
		adapter: "eranet_phishing_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: ERANET_PROVIDER.version, contentHash: ERANET_PROVIDER.contentHash },
		target: { domain, observedUrl },
		report: { subTypes: eranetSubTypes(params.allegationCategory), description, website: params.website },
		...(params.evidence ? { evidence: params.evidence } : {}),
	};
}

export function storedEranetSubmissionPayload(value: unknown): EranetSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const target = payload && recordValue(payload.target);
	const report = payload && recordValue(payload.report);
	if (!payload || payload.adapter !== "eranet_phishing_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== ERANET_PROVIDER.version || definition?.contentHash !== ERANET_PROVIDER.contentHash
		|| typeof target?.domain !== "string" || typeof target.observedUrl !== "string"
		|| !report || !Array.isArray(report.subTypes) || !report.subTypes.every((type) => type === "phishing_site" || type === "other")
		|| typeof report.description !== "string" || !report.description || report.description.length > ERANET_PROVIDER.maximumDescriptionLength
		|| typeof report.website !== "string" || !report.website) {
		return undefined;
	}
	const evidence = payload.evidence === undefined ? undefined : storedProviderEvidenceImageReference(payload.evidence, ERANET_EVIDENCE_CONTRACT);
	if (payload.evidence !== undefined && !evidence) return undefined;
	return {
		adapter: "eranet_phishing_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: ERANET_PROVIDER.version, contentHash: ERANET_PROVIDER.contentHash },
		target: { domain: target.domain, observedUrl: target.observedUrl },
		report: { subTypes: report.subTypes as EranetSubType[], description: report.description, website: report.website },
		...(evidence ? { evidence } : {}),
	};
}
