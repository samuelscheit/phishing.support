import type { ReporterMetadata } from "../request_metadata";
import { AbuseRepository, type CreatedAbuseReport } from "./repository";
import { type AbuseReportRequest, type ValidatedAbuseReportRequest, validateAbuseReportRequest } from "./contracts";
import { AbuseInputError } from "./security";

const MAX_REPORT_DESCRIPTION_LENGTH = 30_000;

export type ConfirmedWebsitePhishingHandoff = {
	/** Legacy submission identity used solely to make the handoff idempotent. */
	submissionId: bigint;
	/** The URL captured and classified by the website-analysis pipeline. */
	url: string;
	/** The analyst's explanation, or captured-evidence fallback, for the allegation. */
	analysisText: string;
	/** The archive screenshot, when the capture produced a decodable PNG. */
	screenshotPng?: Buffer;
	reporter: ReporterMetadata;
};

function buildRequestWithoutEvidence(params: ConfirmedWebsitePhishingHandoff): AbuseReportRequest {
	const observedUrl = new URL(params.url);
	const description = params.analysisText.trim().slice(0, MAX_REPORT_DESCRIPTION_LENGTH);
	if (!description) throw new Error("A confirmed website-phishing handoff requires analysis evidence.");

	return {
		targets: [observedUrl.hostname],
		allegationCategory: "phishing",
		description,
		observedUrls: [{ target: observedUrl.hostname, urls: [observedUrl.toString()] }],
		reporterIdentity: "service",
		idempotencyKey: `legacy-website:${params.submissionId.toString()}`,
	};
}

/**
 * Build the standalone request from confirmed legacy website evidence. This
 * intentionally has no knowledge of providers, routes, or job scheduling:
 * `AbuseRepository.createReport` owns the normal durable resolve-job enqueue.
 */
export async function validateConfirmedWebsitePhishingHandoff(
	params: ConfirmedWebsitePhishingHandoff,
): Promise<ValidatedAbuseReportRequest> {
	const request = buildRequestWithoutEvidence(params);
	const withoutScreenshot = await validateAbuseReportRequest(request);
	if (!params.screenshotPng || params.screenshotPng.byteLength === 0) return withoutScreenshot;

	// Validate the captured bytes through the standalone request contract rather
	// than trusting the legacy archive's filename or MIME assumption. Since the
	// request without evidence is already valid, an AbuseInputError here can only
	// be caused by the optional screenshot; preserve the report without it.
	try {
		return await validateAbuseReportRequest({
			...request,
			evidence: [
				{
					filename: "website.png",
					mimeType: "image/png",
					base64: params.screenshotPng.toString("base64"),
				},
			],
		});
	} catch (error) {
		if (error instanceof AbuseInputError) return withoutScreenshot;
		throw error;
	}
}

/**
 * Handoff point from the legacy website analyser to standalone abuse
 * reporting. A successful return only means the durable report and its normal
 * resolve job were accepted; it never means an external provider accepted the
 * allegation.
 */
export async function handoffConfirmedWebsitePhishing(
	params: ConfirmedWebsitePhishingHandoff,
): Promise<CreatedAbuseReport> {
	const request = await validateConfirmedWebsitePhishingHandoff(params);
	return AbuseRepository.createReport({ request, reporter: params.reporter });
}
