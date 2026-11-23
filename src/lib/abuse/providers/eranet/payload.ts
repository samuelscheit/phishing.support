import { z } from "zod";

import { evidenceContract } from "../kit/evidence";
import { field, payloadEnvelope, registrarTargetOf, storedReader } from "../kit/stored";
import { storedProviderEvidenceImageReference } from "../kit/evidence";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget } from "../kit/report_payload";
import { ERANET_PROVIDER } from "./definition";

export const ERANET_EVIDENCE_CONTRACT = evidenceContract("eranet_report", ERANET_PROVIDER.evidence);

const envelope = payloadEnvelope(ERANET_PROVIDER, "eranet_phishing_report_v1");

/** The durable, secret-free draft: the form values the submission sends. */
const payloadSchema = z.object({
	...envelope.shape,
	target: field.registrarTargetWithUrl,
	/** The form's report-type checkboxes this service files under. */
	report: z.object({ subTypes: z.array(z.enum(["phishing_site", "other"])), description: field.text(ERANET_PROVIDER.maximumDescriptionLength), website: z.string().min(1) }),
	evidence: field.evidence(ERANET_EVIDENCE_CONTRACT),
}).refine(({ target }) => normalizeObservedUrlForTarget(target.observedUrl, target.host) === target.observedUrl);

export type EranetSubmissionPayload = z.infer<typeof payloadSchema>;
export type EranetEvidenceReference = EranetSubmissionPayload["evidence"];

export function eranetSubTypes(allegationCategory: string | undefined): EranetSubmissionPayload["report"]["subTypes"] {
	return allegationCategory === "malware" ? ["other"] : ["phishing_site"];
}

export function makeEranetDescription(params: { target?: string; observedUrl?: string; description: string; allegationCategory?: string; legalBrandUrl?: string }): string | undefined {
	return buildProviderReportNarrative({
		provider: "eranet",
		target: params.target,
		observedUrls: params.observedUrl ? [params.observedUrl] : [],
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl ? { legalBrandUrl: params.legalBrandUrl } : {}),
		maximumLength: ERANET_PROVIDER.maximumDescriptionLength,
	});
}

/**
 * The durable, secret-free Eranet draft. The form's required "legitimate
 * website" field names the impersonated brand's site, or for malware (which
 * impersonates nothing) the case page that holds the evidence.
 */
export function buildEranetSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	allegationCategory?: string;
	website: string;
	legalBrandUrl?: string;
	evidence: EranetEvidenceReference | null;
}): EranetSubmissionPayload | undefined {
	const registrar = registrarTargetOf(params.target);
	const observedUrl = registrar ? normalizeObservedUrlForTarget(params.observedUrl, registrar.host) : undefined;
	const description = makeEranetDescription({
		target: registrar?.host,
		observedUrl,
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl ? { legalBrandUrl: params.legalBrandUrl } : {}),
	});
	if (!registrar || !observedUrl || !description || !params.website || !params.evidence || !storedProviderEvidenceImageReference(params.evidence, ERANET_EVIDENCE_CONTRACT)) return undefined;
	return {
		...envelope.stamp,
		target: { ...registrar, observedUrl },
		report: { subTypes: eranetSubTypes(params.allegationCategory), description, website: params.website },
		evidence: params.evidence,
	};
}

export const storedEranetSubmissionPayload = storedReader(payloadSchema);
