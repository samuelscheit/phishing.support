import { z } from "zod";

import { normalizeDomain } from "../../security/security";
import { evidenceContract } from "../kit/evidence";
import type { ReportInput } from "../kit/draft";
import { field, leadsWithReference, payloadEnvelope, storedReader } from "../kit/stored";
import { listedFreeText } from "../kit/text";
import { isReportReference } from "../kit/report_reference";
import type { ProviderEvidenceImageReference } from "../kit/evidence";
import { NAME_COM_PROVIDER as PROVIDER } from "./definition";

export const NAME_COM_EVIDENCE_CONTRACT = evidenceContract("name_com_report", PROVIDER.evidence);

const envelope = payloadEnvelope(PROVIDER, "name_com_report_v1");

/**
 * The durable, secret-free draft: the form values the submission sends, besides
 * the page's own fields, its Turnstile token and the uploaded file's path.
 */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ domain: field.domain }),
	report: z.object({
		/** The reference Name.com's ticket mail quotes. */
		trackingId: field.reference,
		additional: field.text(PROVIDER.additionalMaximumLength),
	}),
	/** The screenshot the form takes as an attachment, when the report has one. */
	evidence: field.evidence(NAME_COM_EVIDENCE_CONTRACT).nullable(),
}).refine((payload) => leadsWithReference(payload.report.additional, payload.report.trackingId));

export type NameComSubmissionPayload = z.infer<typeof payloadSchema>;
export type NameComReportInput = ReportInput & { evidence?: ProviderEvidenceImageReference<(typeof PROVIDER.evidence.acceptedMimeTypes)[number]> | null };

/**
 * The form's "Additional Information" takes links and the narrative together,
 * at most 2000 characters (our limit; the form has none).
 */
export const { urls: nameComReportUrls, make: makeNameComAdditional } = listedFreeText("name_com", PROVIDER, { limit: PROVIDER.additionalMaximumLength, urlMaximumLength: PROVIDER.urlMaximumLength });

export function buildNameComSubmissionPayload(input: NameComReportInput): NameComSubmissionPayload | undefined {
	const domain = normalizeDomain(input.target);
	if (!domain || !isReportReference(input.trackingId)) return undefined;
	const urls = nameComReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const additional = makeNameComAdditional({ ...input, target: domain }, urls);
	if (!additional) return undefined;
	return {
		...envelope.stamp,
		target: { domain },
		report: { trackingId: input.trackingId, additional },
		evidence: input.evidence ?? null,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedNameComSubmissionPayload = storedReader(payloadSchema);
