import { z } from "zod";

import { normalizePublicHost, normalizePublicHttpUrl } from "../../security";
import { evidenceContract } from "../kit/evidence";
import { field, payloadEnvelope, storedReader } from "../kit/stored";
import { providerNarrative } from "../kit/text";
import { storedProviderEvidenceImageReference } from "../evidence_image";
import { normalizeObservedUrlForTarget } from "../report_payload";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";

export const ALIBABA_CLOUD_EVIDENCE_CONTRACT = evidenceContract("alibaba_cloud_report", ALIBABA_CLOUD_PROVIDER.evidence);

const envelope = payloadEnvelope(ALIBABA_CLOUD_PROVIDER, "alibaba_cloud_report_v1");

/** The durable, secret-free draft: exactly the form values the submission sends, besides the uploaded file's path. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: z.string() }),
	report: z.object({
		typeReport: z.string().min(1),
		/** "Report Object (URL/domain name/IP)": one item, at most 200 characters. */
		reportDomainIp: field.text(ALIBABA_CLOUD_PROVIDER.reportObjectMaximumLength),
		reportReason: field.text(ALIBABA_CLOUD_PROVIDER.reportReasonMaximumLength),
		/** "Victim (URL/domain name/IP)". */
		impactItem: z.string().min(1),
	}),
	screenshot: field.evidence(ALIBABA_CLOUD_EVIDENCE_CONTRACT),
});

export type AlibabaCloudSubmissionPayload = z.infer<typeof payloadSchema>;
export type AlibabaCloudScreenshotReference = AlibabaCloudSubmissionPayload["screenshot"];

export type AlibabaCloudReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
};

/**
 * The form takes one report object and refuses a value that names two URLs
 * (its pattern rejects a second "http" or "www"). The first observed URL is
 * the most specific object; a URL the field cannot hold falls back to the host.
 */
export function alibabaReportObject(target: string, observedUrls: readonly string[]): string | undefined {
	const host = normalizePublicHost(target);
	if (!host) return undefined;
	for (const value of observedUrls) {
		const url = normalizeObservedUrlForTarget(value, host);
		if (url && url.length <= ALIBABA_CLOUD_PROVIDER.reportObjectMaximumLength && !/(?:https?|www).*(?:https?|www)/i.test(url)) return url;
	}
	return host;
}

export function makeAlibabaCloudReportReason(input: AlibabaCloudReportInput): string | undefined {
	return providerNarrative("alibaba_cloud", input, ALIBABA_CLOUD_PROVIDER.reportReasonMaximumLength);
}

export function buildAlibabaCloudSubmissionPayload(input: AlibabaCloudReportInput & { screenshot: AlibabaCloudScreenshotReference | null }): AlibabaCloudSubmissionPayload | undefined {
	const normalizedTarget = normalizePublicHost(input.target);
	const reportDomainIp = normalizedTarget ? alibabaReportObject(normalizedTarget, input.observedUrls) : undefined;
	const reportReason = makeAlibabaCloudReportReason(input);
	if (!normalizedTarget || !reportDomainIp || !reportReason || !input.screenshot || !storedProviderEvidenceImageReference(input.screenshot, ALIBABA_CLOUD_EVIDENCE_CONTRACT)) return undefined;
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	return {
		...envelope.stamp,
		target: { normalizedTarget },
		report: {
			typeReport: input.allegationCategory === "malware" ? ALIBABA_CLOUD_PROVIDER.reportTypes.malware : ALIBABA_CLOUD_PROVIDER.reportTypes.phishing,
			reportDomainIp,
			reportReason,
			impactItem: legalBrandUrl ?? ALIBABA_CLOUD_PROVIDER.victimFallback,
		},
		screenshot: input.screenshot,
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export const storedAlibabaCloudSubmissionPayload = storedReader(payloadSchema);

/** The SubmitReportTask parameters, as the form sends them for a website report. */
export function alibabaCloudSubmitParams(payload: AlibabaCloudSubmissionPayload, evidenceFile: { fileName: string; filePath: string }, allowCrossRegion: boolean): Record<string, unknown> {
	return {
		carrierReport: ALIBABA_CLOUD_PROVIDER.carrier,
		reportOccurred: false,
		lossMoneyOccurred: false,
		otherFraudResourceInvolved: false,
		typeReport: payload.report.typeReport,
		reportDomainIp: payload.report.reportDomainIp,
		reportReason: payload.report.reportReason,
		reportEvidenceFile: [{ ...evidenceFile, originalName: evidenceFile.fileName }],
		impactItem: payload.report.impactItem,
		reporterPublic: ALIBABA_CLOUD_PROVIDER.reporter.name,
		emailPublic: ALIBABA_CLOUD_PROVIDER.reporter.email,
		area: ALIBABA_CLOUD_PROVIDER.reporter.area,
		pageType: ALIBABA_CLOUD_PROVIDER.pageType,
		foundDeceiveTime: "",
		...(allowCrossRegion ? { allowCrossRegion: true } : {}),
	};
}
