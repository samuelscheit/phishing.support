import { z } from "zod";

import { asRecord } from "../../../util/values";
import type { ReportInput } from "../kit/draft";
import { evidenceContract } from "../kit/evidence";
import { field, registrarTargetOf, leadsWithReference, payloadEnvelope, storedReader } from "../kit/stored";
import { listedFreeText } from "../kit/text";
import { isReportReference } from "../kit/report_reference";
import { NEWFOLD_PROVIDER as PROVIDER } from "./definition";

export const NEWFOLD_EVIDENCE_CONTRACT = evidenceContract("newfold_report", PROVIDER.evidence);

const envelope = payloadEnvelope(PROVIDER, "newfold_report_v1");
const knownBrand = (value: unknown): value is string => typeof value === "string" && (PROVIDER.brands as readonly string[]).includes(value);

/** The durable, secret-free draft: the form values the filing request sends besides the captcha token and the constant hidden fields. */
const payloadSchema = z.object({
	...envelope.shape,
	target: field.registrarTarget,
	report: z.object({
		/** The reference Newfold's case mail may quote; it leads the comments. */
		trackingId: field.reference,
		/** The form's "Domain" field: the first reported URL. */
		url: field.url(PROVIDER.urlMaximumLength),
		/** The `brand` option, i.e. the queue of the brand whose route this is. */
		brand: z.string().refine(knownBrand),
		comments: field.text(PROVIDER.commentsMaximumLength),
	}),
	/** The screenshot the form takes as its one attachment, when the report has one. */
	evidence: field.evidence(NEWFOLD_EVIDENCE_CONTRACT).nullable(),
}).refine((payload) => leadsWithReference(payload.report.comments, payload.report.trackingId));

export type NewfoldSubmissionPayload = z.infer<typeof payloadSchema>;
export type NewfoldReportInput = ReportInput & { brand: string; evidence?: NewfoldSubmissionPayload["evidence"] };

/** The form's brand for a route: by the registrar ID that selected it, else by its abuse mailbox, else "Other". */
export function newfoldBrandForRoute(route: { verifiedEmail?: string | null; resolverProvenance?: unknown }): string {
	const byRegistrarId: Readonly<Record<number, string>> = PROVIDER.brandByRegistrarId;
	const byMailbox: Readonly<Record<string, string>> = PROVIDER.brandByMailbox;
	const registrarId = asRecord(route.resolverProvenance)?.registrarId;
	if (typeof registrarId === "number" && byRegistrarId[registrarId]) return byRegistrarId[registrarId]!;
	return byMailbox[route.verifiedEmail?.trim().toLowerCase() ?? ""] ?? PROVIDER.defaultBrand;
}

/**
 * The comments become the CRM case's description, at most 1000 characters. The
 * reference leads; the narrative gets what the URL block, hosting line and
 * case link leave.
 */
export const { urls: newfoldReportUrls, make: makeNewfoldComments } = listedFreeText("newfold", PROVIDER, { limit: PROVIDER.commentsMaximumLength, urlMaximumLength: PROVIDER.urlMaximumLength });

export function buildNewfoldSubmissionPayload(input: NewfoldReportInput): NewfoldSubmissionPayload | undefined {
	const target = registrarTargetOf(input.target);
	if (!target || !isReportReference(input.trackingId) || !knownBrand(input.brand)) return undefined;
	const domain = target.host;
	const urls = newfoldReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const comments = makeNewfoldComments({ ...input, target: domain }, urls);
	if (!comments) return undefined;
	return {
		...envelope.stamp,
		target,
		report: { trackingId: input.trackingId, url: urls[0]!, brand: input.brand, comments },
		evidence: input.evidence ?? null,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedNewfoldSubmissionPayload = storedReader(payloadSchema);
