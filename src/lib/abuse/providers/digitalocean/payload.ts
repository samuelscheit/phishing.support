import { isIP } from "node:net";
import { z } from "zod";

import { normalizePublicHost, normalizePublicHttpUrl, registrableDomain } from "../../security/security";
import type { ReportInput } from "../kit/draft";
import { field, leadsWithReference, payloadEnvelope, storedReader } from "../kit/stored";
import { listedFreeText } from "../kit/text";
import { isReportReference } from "../kit/report_reference";
import { DIGITALOCEAN_PROVIDER as PROVIDER } from "./definition";

const envelope = payloadEnvelope(PROVIDER, "digitalocean_abuse_report_v1");
const abuseTypes = Object.values(PROVIDER.abuseTypes);

/** The durable, secret-free draft: every value the form request sends besides the reporter and the constants. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: z.string().min(1) }),
	report: z.object({
		trackingId: field.reference,
		abuseType: z.string().refine((value) => abuseTypes.includes(value as never)),
		/** "Target of the phishing campaign": the impersonated brand's domain, or Unknown. */
		campaignTarget: field.text(PROVIDER.inputMaximumLength),
		/** "Evidence URL": the reported page. */
		evidenceUrl: field.url(PROVIDER.urlMaximumLength),
		/** "Source IP": the address the site is served from, when we know it; the field is left out otherwise. */
		sourceIp: z.string().refine((ip) => isIP(ip) !== 0).nullable(),
		/** When the page was captured, in UTC: the form's date, time and timezone. */
		observedAt: z.string().refine((at) => Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at),
		details: field.text(PROVIDER.detailsMaximumLength),
	}),
}).refine((payload) => leadsWithReference(payload.report.details, payload.report.trackingId));

export type DigitalOceanSubmissionPayload = z.infer<typeof payloadSchema>;
export type DigitalOceanReportInput = ReportInput & { sourceIp?: string; capturedAt: Date };

/** The observed URLs the description lists; the first is the form's "Evidence URL". */
export const { urls: digitalOceanReportUrls, make: makeDigitalOceanDetails } = listedFreeText("digitalocean", PROVIDER, {
	limit: PROVIDER.detailsMaximumLength,
	urlMaximumLength: PROVIDER.urlMaximumLength,
});

/** The impersonated brand as the form's free-text "Target of the phishing campaign": its registrable domain. */
export function digitalOceanCampaignTarget(legalBrandUrl: string | null | undefined): string {
	const url = legalBrandUrl ? normalizePublicHttpUrl(legalBrandUrl, { domainOnly: true }) : undefined;
	const domain = url ? registrableDomain(new URL(url).hostname) : undefined;
	return domain && domain.length <= PROVIDER.inputMaximumLength ? domain : PROVIDER.unknownCampaignTarget;
}

function pageHost(observedUrls: readonly string[]): string | undefined {
	for (const value of observedUrls) {
		const url = normalizePublicHttpUrl(value);
		const host = url ? normalizePublicHost(new URL(url).hostname) : undefined;
		if (host) return host;
	}
	return undefined;
}

export function buildDigitalOceanSubmissionPayload(input: DigitalOceanReportInput): DigitalOceanSubmissionPayload | undefined {
	const normalizedTarget = normalizePublicHost(input.target);
	const abuseType = PROVIDER.abuseTypes[input.allegationCategory as keyof typeof PROVIDER.abuseTypes];
	if (!normalizedTarget || !abuseType || !isReportReference(input.trackingId)) return undefined;
	const sourceIp = input.sourceIp && isIP(input.sourceIp) ? input.sourceIp : null;
	// An origin server's pages are the domain's: an address target lists the URLs of the first observed page's host.
	const urlHost = isIP(normalizedTarget) ? pageHost(input.observedUrls) : normalizedTarget;
	if (!urlHost) return undefined;
	const urls = digitalOceanReportUrls(urlHost, input.observedUrls);
	if (urls.length === 0) return undefined;
	const details = makeDigitalOceanDetails({ ...input, target: normalizedTarget }, urls);
	if (!details) return undefined;
	return {
		...envelope.stamp,
		target: { normalizedTarget },
		report: {
			trackingId: input.trackingId,
			abuseType,
			campaignTarget: digitalOceanCampaignTarget(input.legalBrandUrl),
			evidenceUrl: urls[0]!,
			sourceIp,
			observedAt: input.capturedAt.toISOString(),
			details,
		},
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedDigitalOceanSubmissionPayload = storedReader(payloadSchema);
