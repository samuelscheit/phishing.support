import type { AbuseArtifact } from "../../schema";
import { normalizeDomain, registrableDomain } from "../../security";
import { recordValue } from "../../worker/shared";
import {
	isIntactProviderEvidenceImageArtifact,
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import { buildProviderReportNarrative } from "../report_payload";
import { TENCENT_PROVIDER } from "./definition";

const maximumExplanationLength = 400;
export const TENCENT_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: [TENCENT_PROVIDER.evidence.requiredMimeType],
	maximumBytes: TENCENT_PROVIDER.evidence.maximumBytes,
	filenamePrefix: "tencent_report",
} as const satisfies ProviderEvidenceImageContract<"image/png">;

export type TencentScreenshotReference = ProviderEvidenceImageReference<"image/png">;

export type TencentSubmissionPayload = {
	adapter: "tencent_cloud_dns_abuse_v1";
	providerNarrativeVersion: 1;
	definition: {
		version: string;
		contentHash: string;
	};
	target: {
		normalizedTarget: string;
		observedUrl: string;
		registrableDomain: string;
	};
	report: {
		explanation: string;
		legalBrandUrl?: string;
	};
	screenshot: TencentScreenshotReference;
};

/** Keep Tencent's small description field provider-specific and deterministic. */
export function makeTencentExplanation(params: {
	target?: string;
	observedUrl?: string;
	description: string;
	legalBrandUrl?: string;
}): string | undefined {
	return buildProviderReportNarrative({
		provider: "tencent",
		target: params.target,
		observedUrls: params.observedUrl ? [params.observedUrl] : [],
		description: params.description,
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
		maximumLength: maximumExplanationLength,
	});
}

/** Verify the artifact bytes as well as their immutable metadata before use. */
export function isIntactTencentScreenshotArtifact(
	artifact: Pick<AbuseArtifact, "kind" | "mimeType" | "sha256" | "size" | "blob">,
): boolean {
	return isIntactProviderEvidenceImageArtifact(artifact, TENCENT_EVIDENCE_CONTRACT);
}

/**
 * Tencent accepts one PNG screenshot. Select only a report-owned original
 * artifact whose bytes and immutable metadata still agree with its hash.
 */
export function selectTencentScreenshotArtifact(artifacts: readonly AbuseArtifact[]): TencentScreenshotReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, TENCENT_EVIDENCE_CONTRACT);
}

function observedUrlForTarget(value: string, target: string): { observedUrl: string; registrableDomain: string } | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
	const normalizedTarget = normalizeDomain(target);
	const hostname = normalizeDomain(url.hostname);
	if (!normalizedTarget || !hostname || (hostname !== normalizedTarget && !hostname.endsWith(`.${normalizedTarget}`))) return undefined;
	const domain = registrableDomain(hostname);
	if (!domain) return undefined;
	url.hostname = hostname;
	url.hash = "";
	return { observedUrl: url.toString(), registrableDomain: domain };
}

function validLegalBrandUrl(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !normalizeDomain(url.hostname)) return undefined;
		url.hostname = normalizeDomain(url.hostname)!;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Create the durable, secret-free Tencent report draft before any provider call. */
export function buildTencentSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	legalBrandUrl?: string;
	screenshot: TencentScreenshotReference;
}): TencentSubmissionPayload | undefined {
	const normalizedTarget = normalizeDomain(params.target);
	const observed = normalizedTarget ? observedUrlForTarget(params.observedUrl, normalizedTarget) : undefined;
	const explanation = makeTencentExplanation({
		target: normalizedTarget,
		observedUrl: observed?.observedUrl,
		description: params.description,
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
	});
	if (!normalizedTarget || !observed || !explanation || !validTencentScreenshotReference(params.screenshot)) return undefined;
	const legalBrandUrl = validLegalBrandUrl(params.legalBrandUrl);
	if (params.legalBrandUrl !== undefined && !legalBrandUrl) return undefined;

	return {
		adapter: "tencent_cloud_dns_abuse_v1",
		providerNarrativeVersion: 1,
		definition: { version: TENCENT_PROVIDER.version, contentHash: TENCENT_PROVIDER.contentHash },
		target: {
			normalizedTarget,
			observedUrl: observed.observedUrl,
			registrableDomain: observed.registrableDomain,
		},
		report: { explanation, ...(legalBrandUrl ? { legalBrandUrl } : {}) },
		screenshot: params.screenshot,
	};
}

function validTencentScreenshotReference(value: unknown): value is TencentScreenshotReference {
	return storedProviderEvidenceImageReference(value, TENCENT_EVIDENCE_CONTRACT) !== undefined;
}

/** Read only a payload previously built by this provider before its submission marker. */
export function storedTencentSubmissionPayload(value: unknown): TencentSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const target = payload && recordValue(payload.target);
	const report = payload && recordValue(payload.report);
	if (!payload || payload.adapter !== "tencent_cloud_dns_abuse_v1" || payload.providerNarrativeVersion !== 1
		|| !definition || definition.version !== TENCENT_PROVIDER.version || definition.contentHash !== TENCENT_PROVIDER.contentHash
		|| !target || typeof target.normalizedTarget !== "string" || typeof target.observedUrl !== "string" || typeof target.registrableDomain !== "string"
		|| !report || typeof report.explanation !== "string" || report.explanation.trim().length === 0
		|| report.explanation.length > maximumExplanationLength
		|| (report.legalBrandUrl !== undefined && !validLegalBrandUrl(report.legalBrandUrl))
		|| !validTencentScreenshotReference(payload.screenshot)) {
		return undefined;
	}
	const normalizedTarget = normalizeDomain(target.normalizedTarget);
	const observed = normalizedTarget ? observedUrlForTarget(target.observedUrl, normalizedTarget) : undefined;
	if (!normalizedTarget || normalizedTarget !== target.normalizedTarget || !observed
		|| observed.observedUrl !== target.observedUrl || observed.registrableDomain !== target.registrableDomain) return undefined;
	return {
		adapter: "tencent_cloud_dns_abuse_v1",
		providerNarrativeVersion: 1,
		definition: { version: TENCENT_PROVIDER.version, contentHash: TENCENT_PROVIDER.contentHash },
		target: { normalizedTarget, observedUrl: observed.observedUrl, registrableDomain: observed.registrableDomain },
		report: {
			explanation: report.explanation,
			...(report.legalBrandUrl === undefined ? {} : { legalBrandUrl: report.legalBrandUrl as string }),
		},
		screenshot: payload.screenshot,
	};
}
