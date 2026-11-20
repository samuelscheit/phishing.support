import { z } from "zod";

import { normalizeDomain, normalizePublicHttpUrl } from "../../security/security";
import type { ReportInput } from "../kit/draft";
import { field, leadsWithReference, payloadEnvelope, storedReader } from "../kit/stored";
import { composeFreeText, reportUrls, type UrlRules } from "../kit/text";
import { truncateAtWord } from "../../../util/text";
import { extractedBrandName } from "../kit/report_payload";
import { isReportReference } from "../kit/report_reference";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";
import { bareHost } from "../../../network/url";

const envelope = payloadEnvelope(PROVIDER, "godaddy_report_v1");
const URL_RULES: UrlRules = { minimumLength: 4, maximumLength: 2048, maximum: PROVIDER.api.maximumUrls };

/** The durable, secret-free draft: what either channel files, before the channel is chosen. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ domain: field.domain }),
	report: z.object({
		/** The reference leading `info`; GoDaddy's mail quotes it. */
		trackingId: field.reference,
		type: z.enum(["PHISHING", "MALWARE"]),
		/** The impersonated brand (GoDaddy's `target`). */
		brand: field.text(PROVIDER.brandMaximumLength),
		/** One ticket each through the API; one form for all through the portal. */
		urls: z.array(field.url(URL_RULES.maximumLength, URL_RULES.minimumLength)).min(1).max(PROVIDER.api.maximumUrls).refine((urls) => new Set(urls).size === urls.length),
		info: field.text(PROVIDER.infoMaximumLength),
		/** The case page (the API's `infoUrl`), when the report has one. */
		caseUrl: field.url(URL_RULES.maximumLength, URL_RULES.minimumLength).nullable(),
	}),
}).refine((payload) => leadsWithReference(payload.report.info, payload.report.trackingId));

export type GoDaddySubmissionPayload = z.infer<typeof payloadSchema>;
export type GoDaddyReportType = GoDaddySubmissionPayload["report"]["type"];
export type GoDaddyReportInput = ReportInput;

/** The domain's observed URLs, in order, up to what GoDaddy tolerates per domain; the root page when none. */
export const goDaddyReportUrls = (domain: string, observedUrls: readonly string[]) => reportUrls(domain, observedUrls, URL_RULES);

/** The brand named in the report: the analysis' label, else the legal brand's host, else a neutral word. */
export function goDaddyBrand(description: string, legalBrandUrl: string | null | undefined): string {
	const named = extractedBrandName(description);
	const normalized = legalBrandUrl ? normalizePublicHttpUrl(legalBrandUrl, { domainOnly: true }) : undefined;
	const host = normalized ? bareHost(normalized) : undefined;
	return truncateAtWord(named ?? host ?? PROVIDER.unknownBrand, PROVIDER.brandMaximumLength);
}

/** The free text both channels carry: the reference leads, the narrative gets the rest. */
export const makeGoDaddyInfo = (input: GoDaddyReportInput, urls: readonly string[]) => composeFreeText({
	provider: "godaddy",
	input,
	urls,
	limit: PROVIDER.infoMaximumLength,
	before: [`Reference: ${input.trackingId}`],
	hostingLimit: PROVIDER.hostingLineMaximumLength,
	narrative: { minimum: PROVIDER.narrativeMinimumLength },
});

export function buildGoDaddySubmissionPayload(input: GoDaddyReportInput): GoDaddySubmissionPayload | undefined {
	const domain = normalizeDomain(input.target);
	if (!domain || !isReportReference(input.trackingId)) return undefined;
	const urls = goDaddyReportUrls(domain, input.observedUrls);
	if (urls.length === 0) return undefined;
	const info = makeGoDaddyInfo({ ...input, target: domain }, urls);
	if (!info) return undefined;
	return {
		...envelope.stamp,
		target: { domain },
		report: {
			trackingId: input.trackingId,
			type: input.allegationCategory === "malware" ? "MALWARE" : "PHISHING",
			brand: goDaddyBrand(input.description, input.legalBrandUrl),
			urls,
			info,
			caseUrl: input.caseUrl ? normalizePublicHttpUrl(input.caseUrl) ?? null : null,
		},
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedGoDaddySubmissionPayload = storedReader(payloadSchema);
