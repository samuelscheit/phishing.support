import type { AbuseArtifact } from "../../schema";
import { normalizeDomain } from "../../security";
import { recordValue } from "../../worker/shared";
import {
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget } from "../report_payload";
import { GNAME_PROVIDER, type GnameComplaintKind } from "./definition";

export const GNAME_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: GNAME_PROVIDER.evidence.acceptedMimeTypes,
	maximumBytes: GNAME_PROVIDER.evidence.maximumBytes,
	filenamePrefix: "gname_report",
} as const satisfies ProviderEvidenceImageContract;

export type GnameEvidenceReference = ProviderEvidenceImageReference<(typeof GNAME_PROVIDER.evidence.acceptedMimeTypes)[number]>;

export type GnameSubmissionPayload = {
	adapter: "gname_abuse_complaint_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { domain: string; observedUrl: string };
	report: {
		kind: GnameComplaintKind;
		description: string;
		/** The imitated brand's site, or the case page; only phishing complaints carry it. */
		legalBrandUrl?: string;
	};
	/** The form requires a screenshot. */
	evidence: GnameEvidenceReference;
};

export function gnameComplaintKind(allegationCategory: string | undefined): GnameComplaintKind {
	return allegationCategory === "malware" ? "malware" : "phishing";
}

/** The complaint's `sm`. */
export function makeGnameDescription(params: { target?: string; observedUrl?: string; description: string; allegationCategory?: string; legalBrandUrl?: string }): string | undefined {
	return buildProviderReportNarrative({
		provider: "gname",
		target: params.target,
		observedUrls: params.observedUrl ? [params.observedUrl] : [],
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl ? { legalBrandUrl: params.legalBrandUrl } : {}),
		maximumLength: GNAME_PROVIDER.maximumDescriptionLength,
	});
}

export function selectGnameEvidenceArtifact(artifacts: readonly AbuseArtifact[]): GnameEvidenceReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, GNAME_EVIDENCE_CONTRACT);
}

/** The durable, secret-free GNAME draft: everything but the mailed code and the upload paths. */
export function buildGnameSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	allegationCategory?: string;
	legalBrandUrl: string;
	evidence: GnameEvidenceReference;
}): GnameSubmissionPayload | undefined {
	const domain = normalizeDomain(params.target);
	const observedUrl = domain ? normalizeObservedUrlForTarget(params.observedUrl, domain) : undefined;
	const kind = gnameComplaintKind(params.allegationCategory);
	const asksForBrand = GNAME_PROVIDER.complaintTypes[kind].legalBrandUrl;
	const description = makeGnameDescription({
		target: domain,
		observedUrl,
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
	});
	if (!domain || !observedUrl || !description || (asksForBrand && !params.legalBrandUrl)) return undefined;
	return {
		adapter: "gname_abuse_complaint_v1",
		providerNarrativeVersion: 1,
		definition: { version: GNAME_PROVIDER.version, contentHash: GNAME_PROVIDER.contentHash },
		target: { domain, observedUrl },
		report: { kind, description, ...(asksForBrand ? { legalBrandUrl: params.legalBrandUrl } : {}) },
		evidence: params.evidence,
	};
}

export function storedGnameSubmissionPayload(value: unknown): GnameSubmissionPayload | undefined {
	const payload = recordValue(value);
	const definition = payload && recordValue(payload.definition);
	const target = payload && recordValue(payload.target);
	const report = payload && recordValue(payload.report);
	if (!payload || payload.adapter !== "gname_abuse_complaint_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== GNAME_PROVIDER.version || definition?.contentHash !== GNAME_PROVIDER.contentHash
		|| typeof target?.domain !== "string" || typeof target.observedUrl !== "string"
		|| !report || (report.kind !== "phishing" && report.kind !== "malware")
		|| typeof report.description !== "string" || !report.description || report.description.length > GNAME_PROVIDER.maximumDescriptionLength) {
		return undefined;
	}
	const kind: GnameComplaintKind = report.kind;
	const asksForBrand = GNAME_PROVIDER.complaintTypes[kind].legalBrandUrl;
	if (asksForBrand ? typeof report.legalBrandUrl !== "string" || !report.legalBrandUrl : report.legalBrandUrl !== undefined) return undefined;
	const evidence = storedProviderEvidenceImageReference(payload.evidence, GNAME_EVIDENCE_CONTRACT);
	if (!evidence) return undefined;
	return {
		adapter: "gname_abuse_complaint_v1",
		providerNarrativeVersion: 1,
		definition: { version: GNAME_PROVIDER.version, contentHash: GNAME_PROVIDER.contentHash },
		target: { domain: target.domain, observedUrl: target.observedUrl },
		report: { kind, description: report.description, ...(asksForBrand ? { legalBrandUrl: report.legalBrandUrl as string } : {}) },
		evidence,
	};
}

/** `ymlb`: each domain, with its URL base64-encoded after a bar, as the form joins them. */
export function gnameDomainEntry(target: GnameSubmissionPayload["target"]): string {
	return `${target.domain}|${Buffer.from(target.observedUrl, "utf8").toString("base64")}`;
}
