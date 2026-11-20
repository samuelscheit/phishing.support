import { z } from "zod";

import { normalizePublicHost, normalizePublicHttpUrl } from "../../security";
import type { ReportInput } from "../kit/draft";
import { evidenceContract } from "../kit/evidence";
import { field, payloadEnvelope, storedReader } from "../kit/stored";
import { composeFreeText, reportUrls, type UrlRules } from "../kit/text";
import { extractedBrandName } from "../report_payload";
import { storedProviderEvidenceImageReference } from "../evidence_image";
import { isReportReference } from "../report_reference";
import { TUCOWS_PROVIDER } from "./definition";
import { bareHost } from "../../../network/url";

export const TUCOWS_EVIDENCE_CONTRACT = evidenceContract("tucows_report", TUCOWS_PROVIDER.evidence);

const envelope = payloadEnvelope(TUCOWS_PROVIDER, "tucows_report_v1");
/** The field is `type=url` with the pattern `https?://.+`. */
const URL_RULES: UrlRules = { maximumLength: 2_048 };
const nonEmpty = z.string().min(1);

/** The durable, secret-free draft: the form values the submission sends. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: z.string() }),
	report: z.object({
		reference: field.reference,
		/** The form's "Offending domain name". */
		offendingDomain: nonEmpty,
		/** "Brand Group" and "Brand domain": who is impersonated. */
		brandName: nonEmpty,
		brandDomain: nonEmpty,
		/** "URL of page with offending content". */
		url: field.url(URL_RULES.maximumLength),
		/** "Your message". */
		description: field.text(TUCOWS_PROVIDER.maximumDescriptionLength),
	}),
	evidence: field.evidence(TUCOWS_EVIDENCE_CONTRACT),
});

export type TucowsSubmissionPayload = z.infer<typeof payloadSchema>;
/** Our reference leads the message so that Tucows' case mail quotes it; the screenshot is required. */
export type TucowsReportInput = ReportInput & { evidence: TucowsSubmissionPayload["evidence"] | null };

/** The first observed URLs of the target; the host's root when none is usable. */
export const tucowsReportUrls = (target: string, observedUrls: readonly string[]) => reportUrls(target, observedUrls, URL_RULES);

/** The impersonated brand: a label the analysis names, else the brand domain's own name. */
export function tucowsBrand(description: string, legalBrandUrl: string | null | undefined): { name: string; domain: string } | undefined {
	const brandUrl = legalBrandUrl ? normalizePublicHttpUrl(legalBrandUrl, { domainOnly: true }) : undefined;
	if (!brandUrl) return undefined;
	const domain = bareHost(brandUrl);
	const labels = domain.split(".");
	const label = labels.length > 1 ? labels[labels.length - 2]! : domain;
	return { name: extractedBrandName(description) ?? `${label.charAt(0).toUpperCase()}${label.slice(1)}`, domain };
}

/** The message: our reference first, then the report narrative, the hosting line and the case page that holds the full evidence. */
export const makeTucowsDescription = (input: Omit<TucowsReportInput, "evidence">, urls: readonly string[]) => composeFreeText({
	provider: "tucows",
	input: { ...input, allegationCategory: "phishing" },
	urls,
	limit: TUCOWS_PROVIDER.maximumDescriptionLength,
	before: [`Reference: ${input.trackingId}`],
	hostingLimit: 600,
	narrative: { maximum: TUCOWS_PROVIDER.narrativeMaximumLength },
});

/** The draft, or undefined when the report cannot be filed here: a non-phishing allegation, no brand, no usable URL. */
export function buildTucowsSubmissionPayload(input: TucowsReportInput): TucowsSubmissionPayload | undefined {
	const target = normalizePublicHost(input.target);
	if (!target || input.allegationCategory === "malware" || !isReportReference(input.trackingId, 80)) return undefined;
	if (!input.evidence || !storedProviderEvidenceImageReference(input.evidence, TUCOWS_EVIDENCE_CONTRACT)) return undefined;
	const urls = tucowsReportUrls(target, input.observedUrls);
	const brand = tucowsBrand(input.description, input.legalBrandUrl);
	if (urls.length === 0 || !brand) return undefined;
	const description = makeTucowsDescription({ ...input, target }, urls);
	if (!description) return undefined;
	return {
		...envelope.stamp,
		target: { normalizedTarget: target },
		report: { reference: input.trackingId, offendingDomain: target, brandName: brand.name, brandDomain: brand.domain, url: urls[0]!, description },
		evidence: input.evidence,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedTucowsSubmissionPayload = storedReader(payloadSchema);
