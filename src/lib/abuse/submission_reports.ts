import { isIP } from "node:net";

import type { ReporterMetadata } from "../request_metadata";
import { AbuseRepository, type CreatedAbuseReport } from "./repository";
import { decodeImageEvidence, normalizeAbuseTarget, normalizeObservedUrl, type DecodedEvidence, type NormalizedAbuseTarget, type ValidatedAbuseReportRequest } from "./contracts";
import { AbuseInputError, hashStableJson, isPublicIp, sha256Hex } from "./security";

const MAX_REPORT_DESCRIPTION_LENGTH = 30_000;
/** Netcraft's documented raw-message limit, which is also the strictest mail-evidence consumer. */
export const MAX_REPORTED_EMAIL_BYTES = 20 * 1024 * 1024;

/** The abuse target that stands for the reported phishing message itself. */
export const EMAIL_MESSAGE_TARGET = "phishing-email";

export function submissionReportIdempotencyKey(submissionId: bigint): string {
	return `submission:${submissionId.toString()}`;
}

type SubmissionReportBase = {
	submissionId: bigint;
	/** The analyst's explanation, or captured-evidence fallback, for the allegation. */
	analysisText: string;
	reporter: ReporterMetadata;
};

export type ConfirmedWebsitePhishing = SubmissionReportBase & {
	/** The URL captured and classified by the website-analysis pipeline. */
	url: string;
	/** The archive screenshot, when the capture produced a decodable PNG. */
	screenshotPng?: Buffer;
};

export type ConfirmedEmailPhishing = SubmissionReportBase & {
	/** Recipient-redacted RFC 822 source. It is evidence for every mail route. */
	redactedEml: string;
	/** Public IP of the first external Received hop, when the headers prove one. */
	sendingIp?: string;
	/** Optional rendered screenshot of the message body. */
	screenshotPng?: Buffer;
};

function reportDescription(analysisText: string): string {
	const description = analysisText.trim().slice(0, MAX_REPORT_DESCRIPTION_LENGTH);
	if (!description) throw new Error("A confirmed phishing report requires analysis evidence.");
	return description;
}

async function screenshotEvidence(filename: string, png: Buffer | undefined): Promise<DecodedEvidence[]> {
	if (!png?.byteLength) return [];
	// A capture that does not decode as the PNG it claims is supplementary
	// evidence only; the report proceeds without it.
	try {
		return [await decodeImageEvidence({ filename, mimeType: "image/png", base64: png.toString("base64") })];
	} catch (error) {
		if (error instanceof AbuseInputError) return [];
		throw error;
	}
}

function target(ordinal: number, value: string, observedUrls: string[] = []): NormalizedAbuseTarget {
	return { ordinal, originalInput: value, originalInputs: [value], ...normalizeAbuseTarget(value), observedUrls };
}

function submissionRequest(params: {
	submissionId: bigint;
	description: string;
	targets: NormalizedAbuseTarget[];
	evidence: DecodedEvidence[];
	source: Record<string, unknown>;
}): ValidatedAbuseReportRequest {
	const observedUrls = params.targets
		.filter((item) => item.observedUrls.length > 0)
		.map((item) => ({ target: item.normalizedTarget, urls: item.observedUrls }));
	return {
		originalRequest: { submissionId: params.submissionId.toString(), ...params.source },
		targets: params.targets,
		allegationCategory: "phishing",
		description: params.description,
		observedUrls,
		evidence: params.evidence,
		idempotencyKey: submissionReportIdempotencyKey(params.submissionId),
		requestPayloadHash: hashStableJson({
			submissionId: params.submissionId.toString(),
			targets: params.targets.map(({ normalizedTarget, targetType, observedUrls: urls }) => ({ normalizedTarget, targetType, urls })),
			description: params.description,
			evidence: params.evidence.map(({ filename, mimeType, sha256 }) => ({ filename, mimeType, sha256 })),
		}),
	};
}

/** Build the website report: exactly the captured host, with its URL as observed evidence. */
export async function buildWebsitePhishingRequest(params: ConfirmedWebsitePhishing): Promise<ValidatedAbuseReportRequest> {
	const observedUrl = normalizeObservedUrl(params.url.trim());
	const host = target(0, new URL(observedUrl).hostname, [observedUrl]);
	return submissionRequest({
		submissionId: params.submissionId,
		description: reportDescription(params.analysisText),
		targets: [host],
		evidence: await screenshotEvidence("website.png", params.screenshotPng),
		source: { kind: "website", url: params.url },
	});
}

/**
 * Build the email report. The message itself is always a target so that
 * mail-aware providers receive it; the sending IP becomes a second target
 * whose resolver-derived abuse contact receives the redacted source.
 */
export async function buildEmailPhishingRequest(params: ConfirmedEmailPhishing): Promise<ValidatedAbuseReportRequest> {
	const eml = Buffer.from(params.redactedEml, "utf-8");
	if (eml.byteLength === 0) throw new Error("A confirmed email report requires the redacted message source.");
	const targets: NormalizedAbuseTarget[] = [{
		ordinal: 0,
		originalInput: EMAIL_MESSAGE_TARGET,
		originalInputs: [EMAIL_MESSAGE_TARGET],
		normalizedTarget: EMAIL_MESSAGE_TARGET,
		targetType: "email",
		observedUrls: [],
	}];
	if (params.sendingIp && isIP(params.sendingIp) && isPublicIp(params.sendingIp)) targets.push(target(1, params.sendingIp));
	return submissionRequest({
		submissionId: params.submissionId,
		description: reportDescription(params.analysisText),
		targets,
		evidence: [
			{ filename: "phishing-email.eml", mimeType: "message/rfc822", buffer: eml, sha256: sha256Hex(eml) },
			...await screenshotEvidence("phishing-email.png", params.screenshotPng),
		],
		source: { kind: "email", sendingIp: params.sendingIp ?? null },
	});
}

/**
 * Accept a confirmed submission into the reporting aggregate. A successful
 * return only means the durable report and its resolve job exist; provider
 * outcomes are recorded on its routes.
 */
export async function reportConfirmedWebsitePhishing(params: ConfirmedWebsitePhishing): Promise<CreatedAbuseReport> {
	return AbuseRepository.createReport({ request: await buildWebsitePhishingRequest(params), reporter: params.reporter, submissionId: params.submissionId });
}

export async function reportConfirmedEmailPhishing(params: ConfirmedEmailPhishing): Promise<CreatedAbuseReport> {
	return AbuseRepository.createReport({ request: await buildEmailPhishingRequest(params), reporter: params.reporter, submissionId: params.submissionId });
}
