import type { AbuseArtifact } from "../../schema";
import { normalizePublicHost, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
import {
	selectProviderEvidenceImageArtifact,
	storedProviderEvidenceImageReference,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget } from "../report_payload";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";

export const ALIBABA_CLOUD_EVIDENCE_CONTRACT = {
	acceptedMimeTypes: ALIBABA_CLOUD_PROVIDER.evidence.acceptedMimeTypes,
	maximumBytes: ALIBABA_CLOUD_PROVIDER.evidence.maximumBytes,
	filenamePrefix: "alibaba_cloud_report",
} as const satisfies ProviderEvidenceImageContract<"image/png" | "image/jpeg">;

export type AlibabaCloudScreenshotReference = ProviderEvidenceImageReference<"image/png" | "image/jpeg">;

/** The durable, secret-free draft: exactly the form values the submission sends, besides the uploaded file's path. */
export type AlibabaCloudSubmissionPayload = {
	adapter: "alibaba_cloud_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { normalizedTarget: string };
	report: {
		typeReport: string;
		/** "Report Object (URL/domain name/IP)": one item, at most 200 characters. */
		reportDomainIp: string;
		reportReason: string;
		/** "Victim (URL/domain name/IP)". */
		impactItem: string;
	};
	screenshot: AlibabaCloudScreenshotReference;
};

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
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	return buildProviderReportNarrative({
		provider: "alibaba_cloud",
		target: input.target,
		observedUrls: input.observedUrls,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		maximumLength: ALIBABA_CLOUD_PROVIDER.reportReasonMaximumLength,
	});
}

export function selectAlibabaCloudScreenshot(artifacts: readonly AbuseArtifact[]): AlibabaCloudScreenshotReference | undefined {
	return selectProviderEvidenceImageArtifact(artifacts, ALIBABA_CLOUD_EVIDENCE_CONTRACT);
}

export function buildAlibabaCloudSubmissionPayload(input: AlibabaCloudReportInput & { screenshot: AlibabaCloudScreenshotReference }): AlibabaCloudSubmissionPayload | undefined {
	const normalizedTarget = normalizePublicHost(input.target);
	const reportDomainIp = normalizedTarget ? alibabaReportObject(normalizedTarget, input.observedUrls) : undefined;
	const reportReason = makeAlibabaCloudReportReason(input);
	if (!normalizedTarget || !reportDomainIp || !reportReason || !storedProviderEvidenceImageReference(input.screenshot, ALIBABA_CLOUD_EVIDENCE_CONTRACT)) return undefined;
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	return {
		adapter: "alibaba_cloud_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: ALIBABA_CLOUD_PROVIDER.version, contentHash: ALIBABA_CLOUD_PROVIDER.contentHash },
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
export function storedAlibabaCloudSubmissionPayload(value: unknown): AlibabaCloudSubmissionPayload | undefined {
	const payload = asRecord(value);
	const definition = asRecord(payload?.definition);
	const target = asRecord(payload?.target);
	const report = asRecord(payload?.report);
	const screenshot = storedProviderEvidenceImageReference(payload?.screenshot, ALIBABA_CLOUD_EVIDENCE_CONTRACT);
	if (!payload || payload.adapter !== "alibaba_cloud_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== ALIBABA_CLOUD_PROVIDER.version || definition.contentHash !== ALIBABA_CLOUD_PROVIDER.contentHash
		|| typeof target?.normalizedTarget !== "string" || !report || !screenshot
		|| !["typeReport", "reportDomainIp", "reportReason", "impactItem"].every((field) => typeof report[field] === "string" && (report[field] as string).length > 0)
		|| (report.reportDomainIp as string).length > ALIBABA_CLOUD_PROVIDER.reportObjectMaximumLength
		|| (report.reportReason as string).length > ALIBABA_CLOUD_PROVIDER.reportReasonMaximumLength) return undefined;
	return {
		adapter: "alibaba_cloud_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: ALIBABA_CLOUD_PROVIDER.version, contentHash: ALIBABA_CLOUD_PROVIDER.contentHash },
		target: { normalizedTarget: target.normalizedTarget },
		report: {
			typeReport: report.typeReport as string,
			reportDomainIp: report.reportDomainIp as string,
			reportReason: report.reportReason as string,
			impactItem: report.impactItem as string,
		},
		screenshot,
	};
}

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
