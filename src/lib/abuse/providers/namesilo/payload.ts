import { z } from "zod";

import { hostBelongsToTarget, normalizePublicHttpUrl, registrableDomain } from "../../security/security";
import { evidenceContract } from "../kit/evidence";
import { field, payloadEnvelope, registrarTargetOf, storedReader } from "../kit/stored";
import { providerNarrative } from "../kit/text";
import { storedProviderEvidenceImageReference } from "../kit/evidence";
import { normalizeObservedUrlForTarget } from "../kit/report_payload";
import { NAMESILO_PROVIDER } from "./definition";

export const NAMESILO_EVIDENCE_CONTRACT = evidenceContract("namesilo_report", NAMESILO_PROVIDER.evidence);

const envelope = payloadEnvelope(NAMESILO_PROVIDER, "namesilo_phishing_report_v1");

/** The impersonated brand's site: a public URL that is not the reported target or its registrable domain. */
function normalizedRealWebsite(value: unknown, target: string): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
	const normalized = normalizePublicHttpUrl(value, { domainOnly: true });
	if (!normalized) return undefined;
	const host = new URL(normalized).hostname;
	if (hostBelongsToTarget(host, target) || registrableDomain(host) === registrableDomain(target)) return undefined;
	return normalized;
}

/** The durable, secret-free draft: the form values the submission sends. */
const payloadSchema = z.object({
	...envelope.shape,
	target: field.registrarTargetWithUrl,
	report: z.object({ realWebsite: field.brandUrl, explanation: field.text(NAMESILO_PROVIDER.maximumReportLength) }),
	evidence: field.evidence(NAMESILO_EVIDENCE_CONTRACT),
}).refine(({ target, report }) => normalizeObservedUrlForTarget(target.observedUrl, target.host) === target.observedUrl
	&& normalizedRealWebsite(report.realWebsite, target.host) === report.realWebsite);

export type NameSiloSubmissionPayload = z.infer<typeof payloadSchema>;
export type NameSiloEvidenceReference = NameSiloSubmissionPayload["evidence"];

/** Build NameSilo's bounded free-text report without forwarding raw analysis. */
export function makeNameSiloExplanation(params: {
	target?: string;
	observedUrl?: string;
	description: string;
	allegationCategory?: string;
	realWebsite?: string;
}): string | undefined {
	return providerNarrative("namesilo", {
		target: params.target ?? "",
		observedUrls: params.observedUrl ? [params.observedUrl] : [],
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		legalBrandUrl: params.realWebsite ?? null,
	}, NAMESILO_PROVIDER.maximumReportLength);
}

/** Create the durable, secret-free NameSilo draft before any provider call. */
export function buildNameSiloSubmissionPayload(params: {
	target: string;
	observedUrl: string;
	description: string;
	allegationCategory?: string;
	realWebsite: string;
	evidence: NameSiloEvidenceReference | null;
}): NameSiloSubmissionPayload | undefined {
	const registrar = registrarTargetOf(params.target);
	const target = registrar?.host;
	const observedUrl = target ? normalizeObservedUrlForTarget(params.observedUrl, target) : undefined;
	const realWebsite = target ? normalizedRealWebsite(params.realWebsite, target) : undefined;
	const explanation = makeNameSiloExplanation({
		...(target ? { target } : {}),
		...(observedUrl ? { observedUrl } : {}),
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(realWebsite ? { realWebsite } : {}),
	});
	const evidence = params.evidence && storedProviderEvidenceImageReference(params.evidence, NAMESILO_EVIDENCE_CONTRACT);
	if (!registrar || !observedUrl || !realWebsite || !explanation || !evidence) return undefined;
	return {
		...envelope.stamp,
		target: { ...registrar, observedUrl },
		report: { realWebsite, explanation },
		evidence,
	};
}

/** Read only a payload previously constructed by this provider. */
export const storedNameSiloSubmissionPayload = storedReader(payloadSchema);
