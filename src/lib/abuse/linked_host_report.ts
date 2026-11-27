import { normalizeAbuseTarget, normalizeObservedUrl, type allegationCategories, type ValidatedAbuseReportRequest } from "./contracts";
import { websiteSite } from "../website/info/site";
import { hashStableJson, sha256Hex, stableJson } from "../util/hash";

/** The confirmed page's stamped screenshot. Forms such as Eranet's, NameSilo's and Squarespace's require an image. */
export type PageScreenshot = { buffer: Buffer; mimeType: "image/png" | "image/jpeg" };

/** The confirmed page's screenshot as evidence of a report against a host the page depends on. */
export function pageScreenshotEvidence(screenshot: PageScreenshot): ValidatedAbuseReportRequest["evidence"][number] {
	return {
		filename: `lure-page.${screenshot.mimeType === "image/png" ? "png" : "jpg"}`,
		mimeType: screenshot.mimeType,
		buffer: screenshot.buffer,
		sha256: sha256Hex(screenshot.buffer),
	};
}

export type LinkedHostReport = {
	/** The confirmed page's case; the linked report belongs to it. */
	submissionId: bigint;
	/** `payload-host`, `data-drop`, `redirector`: one report per kind and host within its scope. */
	kind: string;
	/**
	 * Whose report it is. A host serving one case's payload is reported once
	 * per case (the default); a host that keeps serving a whole campaign, such
	 * as its redirector, once for good (`"host"`).
	 */
	scope?: "case" | "host";
	allegationCategory: (typeof allegationCategories)[number];
	/** The URL on the reported host the evidence is about. */
	url: string;
	description: string;
	originalRequest: Record<string, unknown>;
	evidenceName: string;
	userAgent?: string;
	pageScreenshot?: PageScreenshot;
} & LinkedBrand;

/**
 * The brand the case's confirmed page impersonates, from its own report: a
 * host the page depends on serves the same lure, and brand-gated forms
 * (Tucows, NameSilo, Eranet, Gname) refuse a report that names none.
 */
export type LinkedBrand = Pick<ValidatedAbuseReportRequest, "legalBrandUrl">;

/**
 * A report against a host the confirmed page depends on but does not live
 * on: different domain, registrar, and hosting, and it keeps serving the next
 * lure after the page is gone. It is linked to the page's case like an
 * exfiltration backend; a rotating per-visit path is the same host.
 */
export function linkedHostRequest(params: LinkedHostReport): ValidatedAbuseReportRequest {
	const observedUrl = normalizeObservedUrl(params.url);
	const target = normalizeAbuseTarget(new URL(observedUrl).hostname);
	const evidence = Buffer.from(stableJson(params.originalRequest), "utf8");
	const site = sha256Hex(websiteSite(observedUrl)).slice(0, 32);
	const idempotencyKey = params.scope === "host" ? `${params.kind}:${site}` : `${params.kind}:${params.submissionId.toString()}:${site}`;
	return {
		originalRequest: params.originalRequest,
		targets: [{ ordinal: 0, originalInput: target.normalizedTarget, originalInputs: [target.normalizedTarget], ...target, observedUrls: [observedUrl] }],
		allegationCategory: params.allegationCategory,
		description: params.description,
		...(params.legalBrandUrl ? { legalBrandUrl: params.legalBrandUrl } : {}),
		...(params.userAgent ? { reportedUserAgent: params.userAgent } : {}),
		observedUrls: [{ target: target.normalizedTarget, urls: [observedUrl] }],
		evidence: [
			{ filename: params.evidenceName, mimeType: "application/json", buffer: evidence, sha256: sha256Hex(evidence) },
			...(params.pageScreenshot ? [pageScreenshotEvidence(params.pageScreenshot)] : []),
		],
		idempotencyKey,
		// Only what identifies the report: a retried investigation fetches again
		// (new time, possibly a rotated path) and must find this report, not
		// collide with it.
		requestPayloadHash: hashStableJson({ idempotencyKey, target: target.normalizedTarget }),
	};
}
