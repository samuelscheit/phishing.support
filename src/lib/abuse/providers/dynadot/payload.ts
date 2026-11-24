import { z } from "zod";

import { normalizePublicHttpUrl } from "../../security/security";
import type { ReportInput } from "../kit/draft";
import { evidenceContract } from "../kit/evidence";
import { field, registrarTargetOf, leadsWithReference, payloadEnvelope, storedReader } from "../kit/stored";
import { listedFreeText } from "../kit/text";
import { isReportReference } from "../kit/report_reference";
import { DYNADOT_PROVIDER as PROVIDER } from "./definition";

export const DYNADOT_EVIDENCE_CONTRACT = evidenceContract("dynadot_report", PROVIDER.evidence);

const envelope = payloadEnvelope(PROVIDER, "dynadot_report_v1");

/** The durable, secret-free draft: the form values the submission sends, besides its Turnstile token and the screenshot's bytes. */
const payloadSchema = z.object({
	...envelope.shape,
	target: field.registrarTarget,
	report: z.object({
		/** The reference at the top of the comment; Dynadot's mail, if any, may quote it. */
		trackingId: field.reference,
		/** "Full Domain Path": the reported URL the form takes one of. */
		domainPath: field.url(PROVIDER.inputMaximumLength),
		/** "Official Website": the impersonated brand's site, or N/A. */
		officialWebsite: field.text(PROVIDER.inputMaximumLength).refine((value) => value === PROVIDER.notApplicable || normalizePublicHttpUrl(value, { domainOnly: true }) === value),
		comments: field.text(PROVIDER.commentsMaximumLength),
	}),
	/** The screenshot the form takes as an upload, when the report has one. */
	evidence: field.evidence(DYNADOT_EVIDENCE_CONTRACT).nullable(),
}).refine((payload) => leadsWithReference(payload.report.comments, payload.report.trackingId));

export type DynadotSubmissionPayload = z.infer<typeof payloadSchema>;
export type DynadotReportInput = ReportInput & { evidence?: DynadotSubmissionPayload["evidence"] };

/** The observed URLs that the form's inputs and the comment's URL block can hold; the first is the "Full Domain Path". The comments carry the reference, URLs, narrative, hosting line and case page. */
export const { urls: dynadotReportUrls, make: makeDynadotComments } = listedFreeText("dynadot", PROVIDER, { limit: PROVIDER.commentsMaximumLength, urlMaximumLength: PROVIDER.inputMaximumLength });

/** The impersonated brand's site for "Official Website", or "N/A" when the report names none that fits. */
export function dynadotOfficialWebsite(legalBrandUrl: string | null | undefined): string {
	const url = legalBrandUrl ? normalizePublicHttpUrl(legalBrandUrl, { domainOnly: true }) : undefined;
	return url && url.length <= PROVIDER.inputMaximumLength ? url : PROVIDER.notApplicable;
}

export function buildDynadotSubmissionPayload(input: DynadotReportInput): DynadotSubmissionPayload | undefined {
	const target = registrarTargetOf(input.target);
	if (!target || !isReportReference(input.trackingId)) return undefined;
	const domain = target.host;
	const urls = dynadotReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const comments = makeDynadotComments({ ...input, target: domain }, urls);
	if (!comments) return undefined;
	return {
		...envelope.stamp,
		target,
		report: { trackingId: input.trackingId, domainPath: urls[0]!, officialWebsite: dynadotOfficialWebsite(input.legalBrandUrl), comments },
		evidence: input.evidence ?? null,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedDynadotSubmissionPayload = storedReader(payloadSchema);
