import { z } from "zod";

import { normalizeDomain, registrableDomain } from "../../security";
import { evidenceContract } from "../kit/evidence";
import { field, payloadEnvelope, storedReader } from "../kit/stored";
import { storedProviderEvidenceImageReference } from "../evidence_image";
import { buildProviderReportNarrative } from "../report_payload";
import { TENCENT_PROVIDER } from "./definition";

const maximumExplanationLength = 400;
export const TENCENT_EVIDENCE_CONTRACT = evidenceContract("tencent_report", { acceptedMimeTypes: [TENCENT_PROVIDER.evidence.requiredMimeType], maximumBytes: TENCENT_PROVIDER.evidence.maximumBytes });

const envelope = payloadEnvelope(TENCENT_PROVIDER, "tencent_cloud_dns_abuse_v1");

/** The form's category options this service reports under; the form also offers Botnets, Pharming, Spam, Others. */
const tencentCategory = (allegationCategory: string | undefined) => allegationCategory === "malware" ? "Malware" as const : "Phishing" as const;

function observedUrlForTarget(value: string, target: string): { observedUrl: string; registrableDomain: string } | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
	const normalizedTarget = normalizeDomain(target);
	const hostname = normalizeDomain(url.hostname);
	if (!normalizedTarget || !hostname || (hostname !== normalizedTarget && !hostname.endsWith(`.${normalizedTarget}`))) return undefined;
	const domain = registrableDomain(hostname);
	if (!domain) return undefined;
	url.hostname = hostname;
	url.hash = "";
	return { observedUrl: url.toString(), registrableDomain: domain };
}

function validLegalBrandUrl(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
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

/** The durable, secret-free draft: the form values the submission sends. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: field.domain, observedUrl: z.string(), registrableDomain: z.string() }),
	report: z.object({
		/** The form's category option, pinned with the narrative. */
		category: z.enum(["Phishing", "Malware"]),
		explanation: field.text(maximumExplanationLength),
		legalBrandUrl: z.string().refine((url) => validLegalBrandUrl(url) === url).optional(),
	}),
	screenshot: field.evidence(TENCENT_EVIDENCE_CONTRACT),
}).refine(({ target }) => {
	const observed = observedUrlForTarget(target.observedUrl, target.normalizedTarget);
	return observed?.observedUrl === target.observedUrl && observed.registrableDomain === target.registrableDomain;
});

export type TencentSubmissionPayload = z.infer<typeof payloadSchema>;
export type TencentScreenshotReference = TencentSubmissionPayload["screenshot"];

/** Keep Tencent's small description field provider-specific and deterministic. */
export function makeTencentExplanation(params: {
	target?: string;
	observedUrl?: string;
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string;
}): string | undefined {
	return buildProviderReportNarrative({
		provider: "tencent",
		target: params.target,
		observedUrls: params.observedUrl ? [params.observedUrl] : [],
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
		maximumLength: maximumExplanationLength,
	});
}

/** Create the durable, secret-free Tencent report draft before any provider call. */
export function buildTencentSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string;
	screenshot: TencentScreenshotReference | null;
}): TencentSubmissionPayload | undefined {
	const normalizedTarget = normalizeDomain(params.target);
	const observed = normalizedTarget ? observedUrlForTarget(params.observedUrl, normalizedTarget) : undefined;
	const explanation = makeTencentExplanation({
		target: normalizedTarget,
		observedUrl: observed?.observedUrl,
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
	});
	if (!normalizedTarget || !observed || !explanation || !params.screenshot || !storedProviderEvidenceImageReference(params.screenshot, TENCENT_EVIDENCE_CONTRACT)) return undefined;
	const legalBrandUrl = validLegalBrandUrl(params.legalBrandUrl);
	if (params.legalBrandUrl !== undefined && !legalBrandUrl) return undefined;

	return {
		...envelope.stamp,
		target: {
			normalizedTarget,
			observedUrl: observed.observedUrl,
			registrableDomain: observed.registrableDomain,
		},
		report: { category: tencentCategory(params.allegationCategory), explanation, ...(legalBrandUrl ? { legalBrandUrl } : {}) },
		screenshot: params.screenshot,
	};
}

/** Read only a payload previously built by this provider before its submission marker. */
export const storedTencentSubmissionPayload = storedReader(payloadSchema);
