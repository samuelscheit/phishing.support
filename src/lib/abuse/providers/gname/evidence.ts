import sharp from "sharp";

import type { DecodedEvidence } from "../../contracts";
import { domainMatchesOrIsSubdomain, isPublicIp, normalizeDomain } from "../../security";
import { GNAME_PROVIDER } from "./definition";

export type CapturedGnameEvidence = {
	url: string;
	screenshot: Buffer;
	mimeType: "image/jpeg" | "image/png";
	capturedAt: Date;
	/** Bounded service-side page context; never sourced from user instructions. */
	pageText?: string;
	pageTitle?: string;
	metadata?: Record<string, unknown>;
};

export type GnameEvidenceDerivative = {
	name: string;
	mimeType: "image/jpeg" | "image/png";
	buffer: Buffer;
	metadata: Record<string, unknown>;
};

type GnameEvidenceDerivativeGeneration = {
	derivatives: GnameEvidenceDerivative[];
	failures: number;
};

export type GnameEvidenceCapture = (url: string) => Promise<CapturedGnameEvidence>;

type GnameEvidenceVerificationResult = {
	passed: boolean;
	reasons: string[];
	derivatives: GnameEvidenceDerivative[];
	captures: CapturedGnameEvidence[];
	observedUrls: string[];
};

const GNAME_MAX_DESCRIPTION = 1_000;

function cleanText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Keep GNAME's submitted description short without losing the report narrative. */
export function makeGnameProviderDescription(description: string, target: string, observedUrls: string[]): string {
	const prefix = `Phishing/fraud report for ${target}. Observed URL(s): ${observedUrls.join(", ")}. `;
	const available = Math.max(0, GNAME_MAX_DESCRIPTION - prefix.length);
	return `${prefix}${cleanText(description).slice(0, available)}`.slice(0, GNAME_MAX_DESCRIPTION);
}

function gnameImageMime(mimeType: string): mimeType is "image/jpeg" | "image/png" {
	return mimeType === "image/jpeg" || mimeType === "image/png";
}

/**
 * Re-encode user evidence into deterministic GNAME derivatives. The source
 * bytes remain in abuse_artifacts; this function never mutates or replaces
 * those originals.
 */
async function generateGnameEvidenceDerivatives(
	evidence: DecodedEvidence[],
): Promise<GnameEvidenceDerivativeGeneration> {
	const eligible = evidence.filter((item) => GNAME_PROVIDER.evidence.acceptedMimeTypes.includes(item.mimeType as "image/jpeg" | "image/png"));
	const derivatives: GnameEvidenceDerivative[] = [];
	let failures = 0;
	for (const [index, item] of eligible.slice(0, GNAME_PROVIDER.evidence.maximumImages).entries()) {
		try {
			const outputMime = item.mimeType === "image/png" ? "image/png" : "image/jpeg";
			const pipeline = sharp(item.buffer, { limitInputPixels: 40_000_000, failOn: "error" }).rotate();
			const buffer = outputMime === "image/png" ? await pipeline.png({ compressionLevel: 9 }).toBuffer() : await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
			if (buffer.byteLength > GNAME_PROVIDER.evidence.maximumBytesPerImage) continue;
			derivatives.push({
				name: `evidence-${index + 1}.${outputMime === "image/png" ? "png" : "jpg"}`,
				mimeType: outputMime,
				buffer,
				metadata: { sourceFilename: item.filename, sourceSha256: item.sha256, provider: GNAME_PROVIDER.key },
			});
		} catch {
			failures += 1;
		}
	}
	return { derivatives, failures };
}

function gnameUrlHost(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return isPublicIp(parsed.hostname) ? undefined : normalizeDomain(parsed.hostname);
	} catch {
		return undefined;
	}
}

function observedUrlBelongsToGnameTarget(url: string, target: string): boolean {
	const host = gnameUrlHost(url);
	return Boolean(host && normalizeDomain(target) && domainMatchesOrIsSubdomain(host, target));
}

/**
 * Verify GNAME's evidence contract. A route is never eligible
 * merely because the submitter asserted that a target is malicious.
 */
export async function verifyGnameEvidence(params: {
	target: string;
	observedUrls: string[];
	legalBrandUrl?: string;
	description: string;
	userEvidence: DecodedEvidence[];
	/** Captures are created by the caller exactly once per observed URL. */
	captures?: CapturedGnameEvidence[];
	captureFailures?: string[];
	classification?: { phishing: boolean; confidence: number; rationale?: string };
}): Promise<GnameEvidenceVerificationResult> {
	const reasons: string[] = [];
	const captures = [...(params.captures ?? [])];
	const targetDomain = normalizeDomain(params.target);
	if (!targetDomain || isPublicIp(targetDomain)) reasons.push("target_must_be_domain");
	if (params.observedUrls.length === 0 || params.observedUrls.some((url) => !observedUrlBelongsToGnameTarget(url, targetDomain ?? ""))) {
		reasons.push("observed_url_not_associated_with_target");
	}
	if (!params.legalBrandUrl) reasons.push("legal_brand_url_required");
	if (params.description.trim().length === 0) reasons.push("description_required");

	for (const capture of captures) {
		if (capture.capturedAt.getTime() < Date.now() - 15 * 60_000) reasons.push("capture_not_fresh");
		if (!gnameImageMime(capture.mimeType)) reasons.push("capture_mime_not_supported");
	}
	if (params.captureFailures?.length) reasons.push(...params.captureFailures);
	if (captures.length === 0) reasons.push("service_capture_required");

	const generated = await generateGnameEvidenceDerivatives(
		[
			...params.userEvidence,
			...captures.map((capture, index) => ({
				filename: `capture-${index + 1}.${capture.mimeType === "image/png" ? "png" : "jpg"}`,
				mimeType: capture.mimeType,
				buffer: capture.screenshot,
				sha256: `capture-${index}`,
			})),
		],
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
