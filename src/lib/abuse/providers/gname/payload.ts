import { z } from "zod";

import { normalizeDomain } from "../../security";
import { evidenceContract } from "../kit/evidence";
import { field, payloadEnvelope, storedReader } from "../kit/stored";
import { storedProviderEvidenceImageReference } from "../evidence_image";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget } from "../report_payload";
import { GNAME_PROVIDER, type GnameComplaintKind } from "./definition";

export const GNAME_EVIDENCE_CONTRACT = evidenceContract("gname_report", GNAME_PROVIDER.evidence);

const envelope = payloadEnvelope(GNAME_PROVIDER, "gname_abuse_complaint_v1");

/** The durable, secret-free draft: everything but the mailed code and the upload paths. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ domain: field.domain, observedUrl: z.string() }),
	report: z.object({
		kind: z.enum(["phishing", "malware"]),
		description: field.text(GNAME_PROVIDER.maximumDescriptionLength),
		/** The imitated brand's site, or the case page; only the complaint types that ask for it carry it. */
		legalBrandUrl: z.string().min(1).optional(),
	}),
	/** The form requires a screenshot. */
	evidence: field.evidence(GNAME_EVIDENCE_CONTRACT),
}).refine(({ target, report }) => normalizeObservedUrlForTarget(target.observedUrl, target.domain) === target.observedUrl
	&& GNAME_PROVIDER.complaintTypes[report.kind].legalBrandUrl === (report.legalBrandUrl !== undefined));

export type GnameSubmissionPayload = z.infer<typeof payloadSchema>;
export type GnameEvidenceReference = GnameSubmissionPayload["evidence"];

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

/** The durable, secret-free GNAME draft: everything but the mailed code and the upload paths. */
export function buildGnameSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	allegationCategory?: string;
	legalBrandUrl: string;
	evidence: GnameEvidenceReference | null;
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
	if (!domain || !observedUrl || !description || (asksForBrand && !params.legalBrandUrl)
		|| !params.evidence || !storedProviderEvidenceImageReference(params.evidence, GNAME_EVIDENCE_CONTRACT)) return undefined;
	return {
		...envelope.stamp,
		target: { domain, observedUrl },
		report: { kind, description, ...(asksForBrand ? { legalBrandUrl: params.legalBrandUrl } : {}) },
		evidence: params.evidence,
	};
}

export const storedGnameSubmissionPayload = storedReader(payloadSchema);

/** `ymlb`: each domain, with its URL base64-encoded after a bar, as the form joins them. */
export function gnameDomainEntry(target: GnameSubmissionPayload["target"]): string {
	return `${target.domain}|${Buffer.from(target.observedUrl, "utf8").toString("base64")}`;
}
