import { normalizeDomain, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
import { buildProviderReportNarrative, extractedBrandName, normalizeObservedUrlForTarget, truncateProviderText } from "../report_payload";
import { isReportReference } from "../report_reference";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";

export type GoDaddyReportType = "PHISHING" | "MALWARE";

/** The durable, secret-free draft: what either channel files, before the channel is chosen. */
export type GoDaddySubmissionPayload = {
	adapter: "godaddy_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { domain: string };
	report: {
		/** The reference leading `info`; GoDaddy's mail quotes it. */
		trackingId: string;
		type: GoDaddyReportType;
		/** The impersonated brand (GoDaddy's `target`). */
		brand: string;
		/** One ticket each through the API; one form for all through the portal. */
		urls: string[];
		info: string;
		/** The case page (the API's `infoUrl`), when the report has one. */
		caseUrl: string | null;
	};
};

export type GoDaddyReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
	trackingId: string;
	caseUrl?: string;
	hostingLine?: string;
};

function validUrl(value: unknown): value is string {
	return typeof value === "string" && value.length >= 4 && value.length <= 2048 && !/\s/.test(value) && normalizePublicHttpUrl(value) === value;
}

/** The domain's observed URLs, in order, up to what GoDaddy tolerates per domain; the root page when none. */
export function goDaddyReportUrls(domain: string, observedUrls: readonly string[]): string[] {
	const urls: string[] = [];
	for (const value of observedUrls) {
		const url = normalizeObservedUrlForTarget(value, domain);
		if (url && validUrl(url) && !urls.includes(url) && urls.length < PROVIDER.api.maximumUrls) urls.push(url);
	}
	if (urls.length > 0) return urls;
	const root = normalizePublicHttpUrl(`https://${domain}/`);
	return root && validUrl(root) ? [root] : [];
}

/** The brand named in the report: the analysis' label, else the legal brand's host, else a neutral word. */
export function goDaddyBrand(description: string, legalBrandUrl: string | null | undefined): string {
	const named = extractedBrandName(description);
	const normalized = legalBrandUrl ? normalizePublicHttpUrl(legalBrandUrl, { domainOnly: true }) : undefined;
	const host = normalized ? new URL(normalized).hostname.replace(/^www\./, "") : undefined;
	return truncateProviderText(named ?? host ?? PROVIDER.unknownBrand, PROVIDER.brandMaximumLength);
}

/** The free text both channels carry: the reference leads, the narrative gets the rest. */
export function makeGoDaddyInfo(input: GoDaddyReportInput, urls: readonly string[]): string | undefined {
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const before = [`Reference: ${input.trackingId}`];
	const after = [
		input.hostingLine ? truncateProviderText(input.hostingLine, PROVIDER.hostingLineMaximumLength) : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part);
	const room = PROVIDER.infoMaximumLength - [...before, ...after].reduce((sum, part) => sum + part.length, 0) - 2 * (before.length + after.length + 1);
	if (room < PROVIDER.narrativeMinimumLength) return undefined;
	const narrative = buildProviderReportNarrative({
		provider: "godaddy",
		target: input.target,
		observedUrls: urls,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		maximumLength: room,
	});
	return narrative ? [...before, narrative, ...after].join("\n\n") : undefined;
}

export function buildGoDaddySubmissionPayload(input: GoDaddyReportInput): GoDaddySubmissionPayload | undefined {
	const domain = normalizeDomain(input.target);
	if (!domain || !isReportReference(input.trackingId)) return undefined;
	const urls = goDaddyReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const info = makeGoDaddyInfo({ ...input, target: domain }, urls);
	if (!info) return undefined;
	return {
		adapter: "godaddy_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: PROVIDER.version, contentHash: PROVIDER.contentHash },
		target: { domain },
		report: {
			trackingId: input.trackingId,
			type: input.allegationCategory === "malware" ? "MALWARE" : "PHISHING",
			brand: goDaddyBrand(input.description, input.legalBrandUrl),
			urls,
			info,
			caseUrl: input.caseUrl ? normalizePublicHttpUrl(input.caseUrl) ?? null : null,
		},
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export function storedGoDaddySubmissionPayload(value: unknown): GoDaddySubmissionPayload | undefined {
	const payload = asRecord(value);
	const definition = asRecord(payload?.definition);
	const target = asRecord(payload?.target);
	const report = asRecord(payload?.report);
	if (!payload || payload.adapter !== "godaddy_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== PROVIDER.version || definition.contentHash !== PROVIDER.contentHash
		|| typeof target?.domain !== "string" || normalizeDomain(target.domain) !== target.domain
		|| !report || !isReportReference(report.trackingId) || (report.type !== "PHISHING" && report.type !== "MALWARE")
		|| typeof report.brand !== "string" || report.brand.length === 0 || report.brand.length > PROVIDER.brandMaximumLength
		|| !Array.isArray(report.urls) || report.urls.length === 0 || report.urls.length > PROVIDER.api.maximumUrls
		|| !report.urls.every(validUrl) || new Set(report.urls).size !== report.urls.length
		|| typeof report.info !== "string" || report.info.length === 0 || report.info.length > PROVIDER.infoMaximumLength
		|| !report.info.startsWith(`Reference: ${report.trackingId}\n`)
		|| (report.caseUrl !== null && !validUrl(report.caseUrl))) return undefined;
	return {
		adapter: "godaddy_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: PROVIDER.version, contentHash: PROVIDER.contentHash },
		target: { domain: target.domain },
		report: { trackingId: report.trackingId, type: report.type, brand: report.brand, urls: [...report.urls], info: report.info, caseUrl: report.caseUrl },
	};
}
