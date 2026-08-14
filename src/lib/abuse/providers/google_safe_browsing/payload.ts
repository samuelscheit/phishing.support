import { domainMatchesOrIsSubdomain, normalizeDomain } from "../../security";
import { recordValue } from "../../worker/shared";
import { GOOGLE_SAFE_BROWSING_PROVIDER } from "./definition";

export type GoogleSafeBrowsingSubmissionPayload = {
	adapter: "google_safe_browsing_phish_v1";
	definition: {
		version: string;
		contentHash: string;
	};
	target: {
		normalizedTarget: string;
		observedUrl: string;
	};
	report: {
		explanation: string;
	};
};

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	const bounded = value.slice(0, maximum);
	const separator = bounded.lastIndexOf(" ");
	return (separator >= Math.floor(maximum * 0.6) ? bounded.slice(0, separator) : bounded).trim();
}

function normalizedLegalBrandUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
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

function conciseBrandUrl(value: string): string {
	if (value.length <= 320) return value;
	const url = new URL(value);
	return `${url.origin}/`;
}

/**
 * Google has one free-text reason field. Preserve the standalone report's
 * evidence and legal-brand context directly instead of regenerating an AI
 * draft or depending on a legacy reporting record.
 */
export function makeGoogleSafeBrowsingExplanation(params: { description: string; legalBrandUrl?: string }): string | undefined {
	const description = compactText(params.description);
	if (!description) return undefined;
	const legalBrandUrl = normalizedLegalBrandUrl(params.legalBrandUrl);
	if (params.legalBrandUrl !== undefined && !legalBrandUrl) return undefined;
	if (!legalBrandUrl) return truncateText(description, GOOGLE_SAFE_BROWSING_PROVIDER.explanationMaximumLength);

	const brandLine = `\nImpersonated brand: ${conciseBrandUrl(legalBrandUrl)}`;
	const descriptionBudget = Math.max(1, GOOGLE_SAFE_BROWSING_PROVIDER.explanationMaximumLength - brandLine.length);
	return `${truncateText(description, descriptionBudget)}${brandLine}`.trim();
}

function normalizedObservedUrl(value: string, target: string): string | undefined {
	try {
		const url = new URL(value);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !domainMatchesOrIsSubdomain(url.hostname, target)) return undefined;
		url.hostname = normalizeDomain(url.hostname)!;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Build the immutable supplemental-form payload before its browser boundary. */
export function buildGoogleSafeBrowsingSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	legalBrandUrl?: string;
}): GoogleSafeBrowsingSubmissionPayload | undefined {
	const target = normalizeDomain(params.target);
	const observedUrl = target ? normalizedObservedUrl(params.observedUrl, target) : undefined;
	const explanation = makeGoogleSafeBrowsingExplanation({
		description: params.description,
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
	});
	if (!target || !observedUrl || !explanation) return undefined;
	return {
		adapter: "google_safe_browsing_phish_v1",
		definition: { version: GOOGLE_SAFE_BROWSING_PROVIDER.version, contentHash: GOOGLE_SAFE_BROWSING_PROVIDER.contentHash },
		target: { normalizedTarget: target, observedUrl },
		report: { explanation },
	};
}

/** Read only an immutable direct-submission payload produced by this provider. */
export function storedGoogleSafeBrowsingSubmissionPayload(value: unknown): GoogleSafeBrowsingSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const target = payload && recordValue(payload.target);
	const report = payload && recordValue(payload.report);
	if (!payload || payload.adapter !== "google_safe_browsing_phish_v1"
		|| !definition || definition.version !== GOOGLE_SAFE_BROWSING_PROVIDER.version || definition.contentHash !== GOOGLE_SAFE_BROWSING_PROVIDER.contentHash
		|| !target || typeof target.normalizedTarget !== "string" || typeof target.observedUrl !== "string"
		|| !report || typeof report.explanation !== "string" || report.explanation.length === 0 || report.explanation.length > GOOGLE_SAFE_BROWSING_PROVIDER.explanationMaximumLength) {
		return undefined;
	}
	const normalizedTarget = normalizeDomain(target.normalizedTarget);
	if (!normalizedTarget || normalizedTarget !== target.normalizedTarget) return undefined;
	const observed = normalizedObservedUrl(target.observedUrl, normalizedTarget);
	if (!observed || observed !== target.observedUrl) return undefined;
	return {
		adapter: "google_safe_browsing_phish_v1",
		definition: { version: GOOGLE_SAFE_BROWSING_PROVIDER.version, contentHash: GOOGLE_SAFE_BROWSING_PROVIDER.contentHash },
		target: { normalizedTarget, observedUrl: observed },
		report: { explanation: report.explanation },
	};
}
