import { isIP } from "node:net";

import { domainMatchesOrIsSubdomain, normalizePublicHost } from "../../security";
import { recordValue } from "../../worker/shared";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget, truncateProviderText } from "../report_payload";
import { GOOGLE_CLOUD_PROVIDER, GOOGLE_CLOUD_SERVICES, type GoogleCloudService } from "./definition";

export type GoogleCloudSubmissionPayload = {
	adapter: "google_cloud_abuse_report_v1";
	providerNarrativeVersion: 1;
	definition: {
		version: string;
		contentHash: string;
	};
	target: {
		normalizedTarget: string;
		observedUrls: string[];
	};
	report: {
		service: GoogleCloudService;
		/** MM/DD/YYYY, the form's own date format, in UTC. */
		abuseDate: string;
		abuseDetails: string;
	};
};

/** Hosts whose Google Cloud product is known from the name alone. */
const SERVICE_BY_HOST: readonly { domain: string; service: GoogleCloudService }[] = [
	{ domain: "storage.googleapis.com", service: "cloud_storage" },
	{ domain: "storage.cloud.google.com", service: "cloud_storage" },
	{ domain: "firebasestorage.googleapis.com", service: "cloud_storage" },
	{ domain: "appspot.com", service: "google_app_engine" },
];

/**
 * The form's service for a target. A Google address is a Compute Engine
 * instance; other Google hosts (sites.google.com, script.google.com) are
 * not Cloud products the form lists, so Google triages them.
 */
export function googleCloudServiceForTarget(target: string): GoogleCloudService {
	if (isIP(target)) return "compute_engine";
	return SERVICE_BY_HOST.find(({ domain }) => domainMatchesOrIsSubdomain(target, domain))?.service ?? "n_a";
}

/** The form's MM/DD/YYYY date of the abuse, which is when the page was captured. */
export function googleCloudAbuseDate(capturedAt: Date): string {
	const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
	const day = String(capturedAt.getUTCDate()).padStart(2, "0");
	return `${month}/${day}/${capturedAt.getUTCFullYear()}`;
}

/**
 * Google asks for every abusive URL or IP address in the details field, and
 * for the date, time and time zone of the abuse. The URLs lead, so they
 * survive the 1,000-character limit; the narrative fills what remains.
 */
export function makeGoogleCloudAbuseDetails(params: {
	target?: string;
	observedUrls: readonly string[];
	description: string;
	capturedAt: Date;
	caseUrl?: string;
	legalBrandUrl?: string;
}): string | undefined {
	if (!params.target || params.observedUrls.length === 0) return undefined;
	const maximum = GOOGLE_CLOUD_PROVIDER.abuseDetailsMaximumLength;
	const urls = `Abusive URLs:\n${params.observedUrls.map((url) => `- ${url}`).join("\n")}`;
	const observed = `Observed: ${params.capturedAt.toISOString().replace(/\.\d{3}Z$/, "Z")} (UTC).`;
	const evidence = params.caseUrl ? `Evidence (screenshot, archived page, analysis): ${params.caseUrl}` : "";
	const fixed = [urls, observed, evidence].filter(Boolean).join("\n");
	const narrativeRoom = maximum - fixed.length - 2;
	const narrative = narrativeRoom > 80
		? buildProviderReportNarrative({
			provider: "google_cloud",
			target: params.target,
			observedUrls: params.observedUrls,
			description: params.description,
			...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
			maximumLength: narrativeRoom,
		})
		: undefined;
	if (params.legalBrandUrl !== undefined && narrativeRoom > 80 && !narrative) return undefined;
	const details = [narrative, fixed].filter(Boolean).join("\n\n");
	return details.length <= maximum ? details : truncateProviderText(urls, maximum);
}

/** Build the immutable form draft before the browser boundary. */
export function buildGoogleCloudSubmissionPayload(params: {
	target: string;
	observedUrls: readonly string[];
	description: string;
	capturedAt: Date;
	caseUrl?: string;
	legalBrandUrl?: string;
}): GoogleCloudSubmissionPayload | undefined {
	const target = normalizePublicHost(params.target);
	if (!target) return undefined;
	const observedUrls = [...new Set(params.observedUrls.map((url) => normalizeObservedUrlForTarget(url, target)).filter((url): url is string => Boolean(url)))];
	const abuseDetails = makeGoogleCloudAbuseDetails({
		target,
		observedUrls,
		description: params.description,
		capturedAt: params.capturedAt,
		...(params.caseUrl ? { caseUrl: params.caseUrl } : {}),
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
	});
	if (observedUrls.length === 0 || !abuseDetails) return undefined;
	return {
		adapter: "google_cloud_abuse_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: GOOGLE_CLOUD_PROVIDER.version, contentHash: GOOGLE_CLOUD_PROVIDER.contentHash },
		target: { normalizedTarget: target, observedUrls },
		report: {
			service: googleCloudServiceForTarget(target),
			abuseDate: googleCloudAbuseDate(params.capturedAt),
			abuseDetails,
		},
	};
}

/** Read only an immutable draft produced by this provider. */
export function storedGoogleCloudSubmissionPayload(value: unknown): GoogleCloudSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const target = payload && recordValue(payload.target);
	const report = payload && recordValue(payload.report);
	if (!payload || payload.adapter !== "google_cloud_abuse_report_v1" || payload.providerNarrativeVersion !== 1
		|| !definition || definition.version !== GOOGLE_CLOUD_PROVIDER.version || definition.contentHash !== GOOGLE_CLOUD_PROVIDER.contentHash
		|| !target || typeof target.normalizedTarget !== "string" || !Array.isArray(target.observedUrls) || target.observedUrls.length === 0
		|| !report || !GOOGLE_CLOUD_SERVICES.includes(report.service as GoogleCloudService)
		|| typeof report.abuseDate !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(report.abuseDate)
		|| typeof report.abuseDetails !== "string" || report.abuseDetails.trim().length === 0
		|| report.abuseDetails.length > GOOGLE_CLOUD_PROVIDER.abuseDetailsMaximumLength) {
		return undefined;
	}
	const normalizedTarget = normalizePublicHost(target.normalizedTarget);
	if (!normalizedTarget || normalizedTarget !== target.normalizedTarget) return undefined;
	const stored = target.observedUrls as unknown[];
	const observedUrls = stored.map((url) => typeof url === "string" ? normalizeObservedUrlForTarget(url, normalizedTarget) : undefined);
	if (observedUrls.some((url, index) => !url || url !== stored[index])) return undefined;
	if (report.service !== googleCloudServiceForTarget(normalizedTarget)) return undefined;
	return {
		adapter: "google_cloud_abuse_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: GOOGLE_CLOUD_PROVIDER.version, contentHash: GOOGLE_CLOUD_PROVIDER.contentHash },
		target: { normalizedTarget, observedUrls: observedUrls as string[] },
		report: { service: report.service as GoogleCloudService, abuseDate: report.abuseDate, abuseDetails: report.abuseDetails },
	};
}
