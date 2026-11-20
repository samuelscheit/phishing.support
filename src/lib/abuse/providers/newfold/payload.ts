import type { AbuseArtifact } from "../../schema";
import { normalizeDomain, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
import {
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget, truncateProviderText } from "../report_payload";
import { isReportReference } from "../report_reference";
import { NEWFOLD_PROVIDER as PROVIDER } from "./definition";

export const NEWFOLD_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: PROVIDER.evidence.acceptedMimeTypes,
	maximumBytes: PROVIDER.evidence.maximumBytes,
	filenamePrefix: "newfold_report",
} as const satisfies ProviderEvidenceImageContract;

export type NewfoldEvidenceReference = ProviderEvidenceImageReference<(typeof PROVIDER.evidence.acceptedMimeTypes)[number]>;

/** The durable, secret-free draft: the form values the filing request sends besides the captcha token and the constant hidden fields. */
export type NewfoldSubmissionPayload = {
	adapter: "newfold_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { domain: string };
	report: {
		/** The reference Newfold's case mail may quote; it leads the comments. */
		trackingId: string;
		/** The form's "Domain" field: the first reported URL. */
		url: string;
		/** The `brand` option, i.e. the queue of the brand whose route this is. */
		brand: string;
		comments: string;
	};
	/** The screenshot the form takes as its one attachment, when the report has one. */
	evidence: NewfoldEvidenceReference | null;
};

export type NewfoldReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
	trackingId: string;
	brand: string;
	caseUrl?: string;
	/** `hostingAddressLine` of the route, when the target resolved to a hoster's address. */
	hostingLine?: string;
	evidence?: NewfoldEvidenceReference | null;
};

function knownBrand(value: unknown): value is string {
	return typeof value === "string" && PROVIDER.brands.includes(value);
}

/** The form's brand for a route: by the registrar ID that selected it, else by its abuse mailbox, else "Other". */
export function newfoldBrandForRoute(route: { verifiedEmail?: string | null; resolverProvenance?: unknown }): string {
	const registrarId = asRecord(route.resolverProvenance)?.registrarId;
	if (typeof registrarId === "number" && PROVIDER.brandByRegistrarId[registrarId]) return PROVIDER.brandByRegistrarId[registrarId]!;
	return PROVIDER.brandByMailbox[route.verifiedEmail?.trim().toLowerCase() ?? ""] ?? PROVIDER.defaultBrand;
}

function validUrl(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= PROVIDER.urlMaximumLength && !/\s/.test(value) && normalizePublicHttpUrl(value) === value;
}

/** The observed URLs of the domain, in order, that the comments' URL block can hold. */
export function newfoldReportUrls(domain: string, observedUrls: readonly string[]): string[] {
	const urls: string[] = [];
	let length = 0;
	for (const value of observedUrls) {
		const url = normalizeObservedUrlForTarget(value, domain);
		if (!url || !validUrl(url) || urls.includes(url)) continue;
		// Each line costs its newline and "- ".
		if (urls.length >= PROVIDER.maximumUrls || length + url.length + 3 > PROVIDER.urlsMaximumLength) continue;
		urls.push(url);
		length += url.length + 3;
	}
	if (urls.length > 0) return urls;
	const root = normalizePublicHttpUrl(`https://${domain}/`);
	return root && validUrl(root) ? [root] : [];
}

/**
 * The comments become the CRM case's description, at most 1000 characters. The
 * reference leads; the narrative gets what the URL block, hosting line and
 * case link leave.
 */
export function makeNewfoldComments(input: NewfoldReportInput, urls: readonly string[]): string | undefined {
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const before = [`Reference: ${input.trackingId}`, `Reported URLs:\n${urls.map((url) => `- ${url}`).join("\n")}`];
	const after = [
		input.hostingLine ? truncateProviderText(input.hostingLine, PROVIDER.hostingLineMaximumLength) : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part);
	const room = PROVIDER.commentsMaximumLength - [...before, ...after].reduce((sum, part) => sum + part.length, 0) - 2 * (before.length + after.length + 1);
	if (room < PROVIDER.narrativeMinimumLength) return undefined;
	const narrative = buildProviderReportNarrative({
		provider: "newfold",
		target: input.target,
		observedUrls: urls,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		maximumLength: room,
	});
	if (!narrative) return undefined;
	const comments = [...before, narrative, ...after].join("\n\n");
	return comments.length <= PROVIDER.commentsMaximumLength ? comments : undefined;
}

export function selectNewfoldEvidenceArtifact(artifacts: readonly AbuseArtifact[]): NewfoldEvidenceReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, NEWFOLD_EVIDENCE_CONTRACT);
}

export function buildNewfoldSubmissionPayload(input: NewfoldReportInput): NewfoldSubmissionPayload | undefined {
	const domain = normalizeDomain(input.target);
	if (!domain || !isReportReference(input.trackingId) || !knownBrand(input.brand)) return undefined;
	const urls = newfoldReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const comments = makeNewfoldComments({ ...input, target: domain }, urls);
	if (!comments) return undefined;
	return {
		adapter: "newfold_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: PROVIDER.version, contentHash: PROVIDER.contentHash },
		target: { domain },
		report: { trackingId: input.trackingId, url: urls[0]!, brand: input.brand, comments },
		evidence: input.evidence ?? null,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export function storedNewfoldSubmissionPayload(value: unknown): NewfoldSubmissionPayload | undefined {
	const payload = asRecord(value);
	const definition = asRecord(payload?.definition);
	const target = asRecord(payload?.target);
	const report = asRecord(payload?.report);
	if (!payload || payload.adapter !== "newfold_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== PROVIDER.version || definition.contentHash !== PROVIDER.contentHash
		|| typeof target?.domain !== "string" || normalizeDomain(target.domain) !== target.domain
		|| !report || !isReportReference(report.trackingId) || !knownBrand(report.brand) || !validUrl(report.url)
		|| typeof report.comments !== "string" || report.comments.length === 0 || report.comments.length > PROVIDER.commentsMaximumLength
		|| !report.comments.startsWith(`Reference: ${report.trackingId}\n`)) return undefined;
	const evidence = payload.evidence === null ? null : storedProviderEvidenceImageReference(payload.evidence, NEWFOLD_EVIDENCE_CONTRACT);
	if (evidence === undefined) return undefined;
	return {
		adapter: "newfold_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: PROVIDER.version, contentHash: PROVIDER.contentHash },
		target: { domain: target.domain },
		report: { trackingId: report.trackingId, url: report.url, brand: report.brand, comments: report.comments },
		evidence,
	};
}
