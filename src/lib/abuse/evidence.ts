import sharp from "sharp";

import type { DecodedEvidence } from "./contracts";
import type { ProviderDefinition } from "./registry";
import { domainMatchesOrIsSubdomain, isPublicIp, normalizeDomain } from "./security";

export type CapturedEvidence = {
	url: string;
	screenshot: Buffer;
	mimeType: "image/jpeg" | "image/png";
	capturedAt: Date;
	/** Bounded service-side page context; never sourced from user instructions. */
	pageText?: string;
	pageTitle?: string;
	metadata?: Record<string, unknown>;
};

export type EvidenceDerivative = {
	name: string;
	mimeType: "image/jpeg" | "image/png";
	buffer: Buffer;
	metadata: Record<string, unknown>;
};

type EvidenceDerivativeGeneration = {
	derivatives: EvidenceDerivative[];
	failures: number;
};

export type EvidenceCapture = (url: string) => Promise<CapturedEvidence>;

export type EvidenceVerificationResult = {
	passed: boolean;
	reasons: string[];
	derivatives: EvidenceDerivative[];
	captures: CapturedEvidence[];
	observedUrls: string[];
};

const MAX_DESCRIPTION = 1_000;

function cleanText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Keep a provider description short without losing a complete narrative in the report record. */
export function makeProviderDescription(description: string, target: string, observedUrls: string[]): string {
	const prefix = `Phishing/fraud report for ${target}. Observed URL(s): ${observedUrls.join(", ")}. `;
	const available = Math.max(0, MAX_DESCRIPTION - prefix.length);
	return `${prefix}${cleanText(description).slice(0, available)}`.slice(0, MAX_DESCRIPTION);
}

function providerImageMime(mimeType: string): mimeType is "image/jpeg" | "image/png" {
	return mimeType === "image/jpeg" || mimeType === "image/png";
}

/**
 * Re-encode user evidence into deterministic provider derivatives. The source
 * bytes remain in abuse_artifacts; this function never mutates or replaces
 * those originals.
 */
async function generateProviderImageDerivatives(
	evidence: DecodedEvidence[],
	definition: ProviderDefinition,
): Promise<EvidenceDerivativeGeneration> {
	const eligible = evidence.filter((item) => definition.evidence.acceptedMimeTypes.includes(item.mimeType as "image/jpeg" | "image/png"));
	const derivatives: EvidenceDerivative[] = [];
	let failures = 0;
	for (const [index, item] of eligible.slice(0, definition.evidence.maximumImages).entries()) {
		try {
			const outputMime = item.mimeType === "image/png" ? "image/png" : "image/jpeg";
			const pipeline = sharp(item.buffer, { limitInputPixels: 40_000_000, failOn: "error" }).rotate();
			const buffer = outputMime === "image/png" ? await pipeline.png({ compressionLevel: 9 }).toBuffer() : await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
			if (buffer.byteLength > definition.evidence.maximumBytesPerImage) continue;
			derivatives.push({
				name: `evidence-${index + 1}.${outputMime === "image/png" ? "png" : "jpg"}`,
				mimeType: outputMime,
				buffer,
				metadata: { sourceFilename: item.filename, sourceSha256: item.sha256, provider: definition.key },
			});
		} catch {
			failures += 1;
		}
	}
	return { derivatives, failures };
}

/** Re-encode only provider-compatible images; malformed items are skipped. */
export async function createProviderImageDerivatives(
	evidence: DecodedEvidence[],
	definition: ProviderDefinition,
): Promise<EvidenceDerivative[]> {
	return (await generateProviderImageDerivatives(evidence, definition)).derivatives;
}

function urlHost(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return isPublicIp(parsed.hostname) ? undefined : normalizeDomain(parsed.hostname);
	} catch {
		return undefined;
	}
}

export function observedUrlBelongsToTarget(url: string, target: string): boolean {
	const host = urlHost(url);
	return Boolean(host && normalizeDomain(target) && domainMatchesOrIsSubdomain(host, target));
}

/**
 * Verify the provider-facing evidence contract. A route is never eligible
 * merely because the submitter asserted that a target is malicious.
 */
export async function verifyProviderEvidence(params: {
	definition: ProviderDefinition;
	target: string;
	observedUrls: string[];
	legalBrandUrl?: string;
	description: string;
	userEvidence: DecodedEvidence[];
	/** Captures are created by the caller exactly once per observed URL. */
	captures?: CapturedEvidence[];
	captureFailures?: string[];
	classification?: { phishing: boolean; confidence: number; rationale?: string };
}): Promise<EvidenceVerificationResult> {
	const reasons: string[] = [];
	const captures = [...(params.captures ?? [])];
	const targetDomain = normalizeDomain(params.target);
	if (!targetDomain || isPublicIp(targetDomain)) reasons.push("target_must_be_domain");
	if (params.observedUrls.length === 0 || params.observedUrls.some((url) => !observedUrlBelongsToTarget(url, targetDomain ?? ""))) {
		reasons.push("observed_url_not_associated_with_target");
	}
	if (!params.legalBrandUrl) reasons.push("legal_brand_url_required");
	if (params.description.trim().length === 0) reasons.push("description_required");

	for (const capture of captures) {
		if (capture.capturedAt.getTime() < Date.now() - 15 * 60_000) reasons.push("capture_not_fresh");
		if (!providerImageMime(capture.mimeType)) reasons.push("capture_mime_not_supported");
	}
	if (params.captureFailures?.length) reasons.push(...params.captureFailures);
	if (captures.length === 0) reasons.push("service_capture_required");

	const generated = await generateProviderImageDerivatives(
		[
			...params.userEvidence,
			...captures.map((capture, index) => ({
				filename: `capture-${index + 1}.${capture.mimeType === "image/png" ? "png" : "jpg"}`,
				mimeType: capture.mimeType,
				buffer: capture.screenshot,
				sha256: `capture-${index}`,
			})),
		],
		params.definition,
	);
	const derivatives = generated.derivatives;
	if (generated.failures > 0) {
		// A malformed derivative is an evidence-contract failure, not a worker
		// crash. Original and successfully captured bytes remain retained.
		reasons.push("provider_evidence_derivative_failed");
	}
	if (derivatives.length === 0) reasons.push("provider_compatible_evidence_required");
	if (params.classification?.phishing !== true || params.classification.confidence < Number(process.env.ABUSE_VERIFIER_MIN_CONFIDENCE ?? 0.85)) {
		reasons.push("phishing_classification_below_threshold");
	}

	return {
		passed: reasons.length === 0,
		reasons: [...new Set(reasons)],
		derivatives,
		captures,
		observedUrls: params.observedUrls,
	};
}
