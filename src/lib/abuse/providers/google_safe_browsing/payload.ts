import { normalizePublicHost } from "../../security";
import { recordValue } from "../../worker/shared";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget } from "../report_payload";
import { GOOGLE_SAFE_BROWSING_PROVIDER } from "./definition";

export type GoogleSafeBrowsingSubmissionPayload = {
	adapter: "google_safe_browsing_phish_v1";
	providerNarrativeVersion: 1;
	definition: {
		version: string;
		contentHash: string;
	};
	target: {
		normalizedTarget: string;
		observedUrl: string;
	};
	report: {
		/**
		 * The form's optional threat category. Google's report_badware path is a
		 * redirect to this same form; the category is what marks a malware report.
		 */
		threat?: GoogleSafeBrowsingThreat;
		explanation: string;
	};
};

/** Labels of the form's "Kategorie der Bedrohung" and "Art der Bedrohung" options (hl=de) for a malware report. */
export const GOOGLE_SAFE_BROWSING_MALWARE_THREAT = { category: "Malware", type: "Desktop-Malware" } as const;
export type GoogleSafeBrowsingThreat = "malware";

/**
 * Google has one free-text reason field. Build it from the report's
 * evidence and legal-brand context instead of regenerating an AI draft.
 */
export function makeGoogleSafeBrowsingExplanation(params: {
	target?: string;
	observedUrl?: string;
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string;
}): string | undefined {
	return buildProviderReportNarrative({
		provider: "google_safe_browsing",
		target: params.target,
		observedUrls: params.observedUrl ? [params.observedUrl] : [],
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
		maximumLength: GOOGLE_SAFE_BROWSING_PROVIDER.explanationMaximumLength,
	});
}

/** Build the immutable supplemental-form payload before its browser boundary. */
export function buildGoogleSafeBrowsingSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string;
}): GoogleSafeBrowsingSubmissionPayload | undefined {
	const target = normalizePublicHost(params.target);
	const observedUrl = target ? normalizeObservedUrlForTarget(params.observedUrl, target) : undefined;
	const explanation = makeGoogleSafeBrowsingExplanation({
		target,
		observedUrl,
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
	});
	if (!target || !observedUrl || !explanation) return undefined;
	return {
		adapter: "google_safe_browsing_phish_v1",
		providerNarrativeVersion: 1,
		definition: { version: GOOGLE_SAFE_BROWSING_PROVIDER.version, contentHash: GOOGLE_SAFE_BROWSING_PROVIDER.contentHash },
		target: { normalizedTarget: target, observedUrl },
		report: { ...(params.allegationCategory === "malware" ? { threat: "malware" as const } : {}), explanation },
	};
}

/** Read only an immutable direct-submission payload produced by this provider. */
export function storedGoogleSafeBrowsingSubmissionPayload(value: unknown): GoogleSafeBrowsingSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const target = payload && recordValue(payload.target);
	const report = payload && recordValue(payload.report);
	if (!payload || payload.adapter !== "google_safe_browsing_phish_v1" || payload.providerNarrativeVersion !== 1
		|| !definition || definition.version !== GOOGLE_SAFE_BROWSING_PROVIDER.version || definition.contentHash !== GOOGLE_SAFE_BROWSING_PROVIDER.contentHash
		|| !target || typeof target.normalizedTarget !== "string" || typeof target.observedUrl !== "string"
		|| !report || (report.threat !== undefined && report.threat !== "malware")
		|| typeof report.explanation !== "string" || report.explanation.length === 0 || report.explanation.length > GOOGLE_SAFE_BROWSING_PROVIDER.explanationMaximumLength) {
		return undefined;
	}
	const normalizedTarget = normalizePublicHost(target.normalizedTarget);
	if (!normalizedTarget || normalizedTarget !== target.normalizedTarget) return undefined;
	const observed = normalizeObservedUrlForTarget(target.observedUrl, normalizedTarget);
	if (!observed || observed !== target.observedUrl) return undefined;
	return {
		adapter: "google_safe_browsing_phish_v1",
		providerNarrativeVersion: 1,
		definition: { version: GOOGLE_SAFE_BROWSING_PROVIDER.version, contentHash: GOOGLE_SAFE_BROWSING_PROVIDER.contentHash },
		target: { normalizedTarget, observedUrl: observed },
		report: { ...(report.threat === "malware" ? { threat: "malware" as const } : {}), explanation: report.explanation },
	};
}
