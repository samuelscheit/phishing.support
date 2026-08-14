import type { AbuseArtifact } from "../../schema";
import { normalizeDomain, registrableDomain, sha256Hex } from "../../security";
import { recordValue } from "../../worker/shared";
import { TENCENT_PROVIDER } from "./definition";

const maximumExplanationLength = 400;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function screenshotFilename(artifactId: string, sha256: string): string {
	return `tencent_report_${artifactId}_${sha256.slice(0, 12).toLowerCase()}.png`;
}

export type TencentScreenshotReference = {
	artifactId: string;
	name: string;
	mimeType: "image/png";
	sha256: string;
	size: number;
	filename: string;
};

export type TencentSubmissionPayload = {
	adapter: "tencent_cloud_dns_abuse_v1";
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

function normalizedText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Keep the Tencent description deterministic and within its small form limit. */
export function makeTencentExplanation(description: string): string | undefined {
	const text = normalizedText(description);
	if (!text) return undefined;
	if (text.length <= maximumExplanationLength) return text;
	const bounded = text.slice(0, maximumExplanationLength);
	const lastSpace = bounded.lastIndexOf(" ");
	return (lastSpace >= Math.floor(maximumExplanationLength * 0.6) ? bounded.slice(0, lastSpace) : bounded).trim();
}

function isPng(bytes: Buffer): boolean {
	return bytes.byteLength >= pngSignature.byteLength && bytes.subarray(0, pngSignature.byteLength).equals(pngSignature);
}

/** Verify the artifact bytes as well as their immutable metadata before use. */
export function isIntactTencentScreenshotArtifact(
	artifact: Pick<AbuseArtifact, "kind" | "mimeType" | "sha256" | "size" | "blob">,
): boolean {
	return artifact.kind === "user_evidence_original"
		&& artifact.mimeType === TENCENT_PROVIDER.evidence.requiredMimeType
		&& Buffer.isBuffer(artifact.blob)
		&& artifact.blob.byteLength > 0
		&& artifact.blob.byteLength <= TENCENT_PROVIDER.evidence.maximumBytes
		&& artifact.size === artifact.blob.byteLength
		&& isPng(artifact.blob)
		&& sha256Hex(artifact.blob) === artifact.sha256.toLowerCase();
}

/**
 * Tencent accepts one PNG screenshot. Select only a report-owned original
 * artifact whose bytes and immutable metadata still agree with its hash.
 */
export function selectTencentScreenshotArtifact(artifacts: readonly AbuseArtifact[]): TencentScreenshotReference | undefined {
	for (const artifact of artifacts) {
		if (!isIntactTencentScreenshotArtifact(artifact)) continue;
		const artifactId = artifact.id.toString();
		return {
			artifactId,
			name: artifact.name,
			mimeType: "image/png",
			sha256: artifact.sha256.toLowerCase(),
			size: artifact.size,
			filename: screenshotFilename(artifactId, artifact.sha256),
		};
	}
	return undefined;
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
	const explanation = makeTencentExplanation(params.description);
	if (!normalizedTarget || !observed || !explanation || !validTencentScreenshotReference(params.screenshot)) return undefined;
	const legalBrandUrl = validLegalBrandUrl(params.legalBrandUrl);
	if (params.legalBrandUrl !== undefined && !legalBrandUrl) return undefined;

	return {
		adapter: "tencent_cloud_dns_abuse_v1",
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
	const screenshot = recordValue(value);
	return Boolean(
		screenshot
		&& typeof screenshot.artifactId === "string" && /^\d+$/.test(screenshot.artifactId)
		&& typeof screenshot.name === "string" && screenshot.name.length > 0 && screenshot.name.length <= 180
		&& screenshot.mimeType === "image/png"
		&& typeof screenshot.sha256 === "string" && /^[a-f0-9]{64}$/.test(screenshot.sha256)
		&& typeof screenshot.size === "number" && Number.isSafeInteger(screenshot.size) && screenshot.size > 0 && screenshot.size <= TENCENT_PROVIDER.evidence.maximumBytes
		&& typeof screenshot.filename === "string" && screenshot.filename === screenshotFilename(screenshot.artifactId, screenshot.sha256),
	);
}

/** Read only a payload previously built by this provider before its submission marker. */
export function storedTencentSubmissionPayload(value: unknown): TencentSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const target = payload && recordValue(payload.target);
	const report = payload && recordValue(payload.report);
	if (!payload || payload.adapter !== "tencent_cloud_dns_abuse_v1"
		|| !definition || definition.version !== TENCENT_PROVIDER.version || definition.contentHash !== TENCENT_PROVIDER.contentHash
		|| !target || typeof target.normalizedTarget !== "string" || typeof target.observedUrl !== "string" || typeof target.registrableDomain !== "string"
		|| !report || typeof report.explanation !== "string" || !validTencentScreenshotReference(payload.screenshot)) {
		return undefined;
	}
	const rebuilt = buildTencentSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl: target.observedUrl,
		description: report.explanation,
		...(report.legalBrandUrl === undefined ? {} : { legalBrandUrl: report.legalBrandUrl as string }),
		screenshot: payload.screenshot,
	});
	if (!rebuilt || rebuilt.report.explanation !== report.explanation || rebuilt.target.registrableDomain !== target.registrableDomain) return undefined;
	return rebuilt;
}
