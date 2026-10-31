import type { AbuseArtifact } from "../../schema";
import {
	hostBelongsToTarget,
	normalizeDomain,
	normalizePublicHttpUrl,
	registrableDomain,
} from "../../security";
import { recordValue } from "../../worker/shared";
import {
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget } from "../report_payload";
import { NAMESILO_PROVIDER } from "./definition";

export const NAMESILO_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: NAMESILO_PROVIDER.evidence.acceptedMimeTypes,
	maximumBytes: NAMESILO_PROVIDER.evidence.maximumBytes,
	filenamePrefix: "namesilo_report",
} as const satisfies ProviderEvidenceImageContract;

export type NameSiloEvidenceReference = ProviderEvidenceImageReference<
	(typeof NAMESILO_PROVIDER.evidence.acceptedMimeTypes)[number]
>;

export type NameSiloSubmissionPayload = {
	adapter: "namesilo_phishing_report_v1";
	providerNarrativeVersion: 1;
	definition: {
		version: string;
		contentHash: string;
	};
	target: {
		normalizedTarget: string;
		registrableDomain: string;
		observedUrl: string;
	};
	report: {
		realWebsite: string;
		explanation: string;
	};
	evidence: NameSiloEvidenceReference;
};

export function selectNameSiloEvidenceArtifact(
	artifacts: readonly AbuseArtifact[],
): NameSiloEvidenceReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, NAMESILO_EVIDENCE_CONTRACT);
}

function normalizedRealWebsite(value: unknown, target: string): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
	const normalized = normalizePublicHttpUrl(value, { domainOnly: true });
	if (!normalized) return undefined;
	const host = new URL(normalized).hostname;
	if (hostBelongsToTarget(host, target) || registrableDomain(host) === registrableDomain(target)) return undefined;
	return normalized;
}

/** Build NameSilo's bounded free-text report without forwarding raw analysis. */
export function makeNameSiloExplanation(params: {
	target?: string;
	observedUrl?: string;
	description: string;
	realWebsite?: string;
}): string | undefined {
	return buildProviderReportNarrative({
		provider: "namesilo",
		target: params.target,
		observedUrls: params.observedUrl ? [params.observedUrl] : [],
		description: params.description,
		...(params.realWebsite ? { legalBrandUrl: params.realWebsite } : {}),
		maximumLength: NAMESILO_PROVIDER.maximumReportLength,
	});
}

/** Create the durable, secret-free NameSilo draft before any provider call. */
export function buildNameSiloSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	realWebsite: string;
	evidence: NameSiloEvidenceReference;
}): NameSiloSubmissionPayload | undefined {
	const target = normalizeDomain(params.target);
	const observedUrl = target ? normalizeObservedUrlForTarget(params.observedUrl, target) : undefined;
	const rootDomain = target ? registrableDomain(target) : undefined;
	const realWebsite = target ? normalizedRealWebsite(params.realWebsite, target) : undefined;
	const explanation = makeNameSiloExplanation({
		target,
		observedUrl,
		description: params.description,
		realWebsite,
	});
	const evidence = storedProviderEvidenceImageReference(params.evidence, NAMESILO_EVIDENCE_CONTRACT);
	if (!target || !observedUrl || !rootDomain || !realWebsite || !explanation || !evidence) return undefined;

	return {
		adapter: "namesilo_phishing_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: NAMESILO_PROVIDER.version, contentHash: NAMESILO_PROVIDER.contentHash },
		target: { normalizedTarget: target, registrableDomain: rootDomain, observedUrl },
		report: { realWebsite, explanation },
		evidence,
	};
}

/** Read only a payload previously constructed by this provider. */
export function storedNameSiloSubmissionPayload(value: unknown): NameSiloSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const target = payload && recordValue(payload.target);
	const report = payload && recordValue(payload.report);
	const evidence = payload && storedProviderEvidenceImageReference(payload.evidence, NAMESILO_EVIDENCE_CONTRACT);
	if (!payload || payload.adapter !== "namesilo_phishing_report_v1" || payload.providerNarrativeVersion !== 1
		|| !definition || definition.version !== NAMESILO_PROVIDER.version || definition.contentHash !== NAMESILO_PROVIDER.contentHash
		|| !target || typeof target.normalizedTarget !== "string" || typeof target.registrableDomain !== "string" || typeof target.observedUrl !== "string"
		|| !report || typeof report.realWebsite !== "string" || typeof report.explanation !== "string"
		|| report.explanation.trim().length === 0 || report.explanation.length > NAMESILO_PROVIDER.maximumReportLength
		|| !evidence) {
		return undefined;
	}
	const normalizedTarget = normalizeDomain(target.normalizedTarget);
	const observedUrl = normalizedTarget ? normalizeObservedUrlForTarget(target.observedUrl, normalizedTarget) : undefined;
	const rootDomain = normalizedTarget ? registrableDomain(normalizedTarget) : undefined;
	const realWebsite = normalizedTarget ? normalizedRealWebsite(report.realWebsite, normalizedTarget) : undefined;
	if (!normalizedTarget || normalizedTarget !== target.normalizedTarget
		|| !observedUrl || observedUrl !== target.observedUrl
		|| !rootDomain || rootDomain !== target.registrableDomain
		|| !realWebsite || realWebsite !== report.realWebsite) {
		return undefined;
	}
	return {
		adapter: "namesilo_phishing_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: NAMESILO_PROVIDER.version, contentHash: NAMESILO_PROVIDER.contentHash },
		target: { normalizedTarget, registrableDomain: rootDomain, observedUrl },
		report: { realWebsite, explanation: report.explanation },
		evidence,
	};
}
