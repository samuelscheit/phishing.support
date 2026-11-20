import { z } from "zod";

import { normalizeDomain } from "../../security";
import type { ReportInput } from "../kit/draft";
import { evidenceContract } from "../kit/evidence";
import { field, leadsWithReference, payloadEnvelope, storedReader } from "../kit/stored";
import { listedFreeText } from "../kit/text";
import { isReportReference } from "../report_reference";
import { PUBLIC_DOMAIN_REGISTRY_PROVIDER as PROVIDER } from "./definition";

export const PUBLIC_DOMAIN_REGISTRY_EVIDENCE_CONTRACT = evidenceContract("publicdomainregistry_report", PROVIDER.evidence);

const envelope = payloadEnvelope(PROVIDER, "publicdomainregistry_report_v1");

/** The durable, secret-free draft: the form values the submission sends, besides the page's own fields, its Turnstile token and the uploaded file's path. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ domain: field.domain }),
	report: z.object({
		/** The reference PDR's ticket mail quotes. */
		trackingId: field.reference,
		complaint: field.text(PROVIDER.complaintMaximumLength),
	}),
	/** The screenshot the form takes as an attachment, when the report has one. */
	evidence: field.evidence(PUBLIC_DOMAIN_REGISTRY_EVIDENCE_CONTRACT).nullable(),
}).refine((payload) => leadsWithReference(payload.report.complaint, payload.report.trackingId));

export type PublicDomainRegistrySubmissionPayload = z.infer<typeof payloadSchema>;
export type PublicDomainRegistryReportInput = ReportInput & { evidence?: PublicDomainRegistrySubmissionPayload["evidence"] };

/**
 * The form's one free-text field takes links and the complaint together, at
 * most 2000 characters. The reference leads so PDR's ticket mail quotes it.
 */
export const { urls: publicDomainRegistryReportUrls, make: makePublicDomainRegistryComplaint } = listedFreeText("publicdomainregistry", PROVIDER, { limit: PROVIDER.complaintMaximumLength, urlMaximumLength: PROVIDER.urlMaximumLength });

export function buildPublicDomainRegistrySubmissionPayload(input: PublicDomainRegistryReportInput): PublicDomainRegistrySubmissionPayload | undefined {
	const domain = normalizeDomain(input.target);
	if (!domain || !isReportReference(input.trackingId)) return undefined;
	const urls = publicDomainRegistryReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const complaint = makePublicDomainRegistryComplaint({ ...input, target: domain }, urls);
	if (!complaint) return undefined;
	return {
		...envelope.stamp,
		target: { domain },
		report: { trackingId: input.trackingId, complaint },
		evidence: input.evidence ?? null,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedPublicDomainRegistrySubmissionPayload = storedReader(payloadSchema);
