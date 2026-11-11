import { isIP } from "node:net";

import type { ReporterMetadata } from "../request_metadata";
import { AbuseRepository, type CreatedAbuseReport } from "./repository";
import { decodeImageEvidence, normalizeAbuseTarget, normalizeObservedUrl, type DecodedEvidence, type NormalizedAbuseTarget, type ValidatedAbuseReportRequest } from "./contracts";
import { AbuseInputError, hashStableJson, isPublicIp, sha256Hex } from "./security";
import { setInvestigationStatus } from "../investigation/status";
import { enqueueKitSiblingDiscovery } from "./origin/kit_job";
import { enqueueRedirectorWatch } from "./origin/redirector_watch";
import { websiteSite } from "../website_site";
import type { ReportableWebsiteFinding, WebsiteHiddenFrame } from "../website_types";
import type { PasteCommand } from "../malware/paste_commands";
import type { InvestigationJobPayload } from "../investigation/payload";

const MAX_REPORT_DESCRIPTION_LENGTH = 30_000;
/** Netcraft's documented raw-message limit, which is also the strictest mail-evidence consumer. */
export const MAX_REPORTED_EMAIL_BYTES = 20 * 1024 * 1024;

/** The abuse target that stands for the reported phishing message itself. */
export const EMAIL_MESSAGE_TARGET = "phishing-email";

type SubmissionReportBase = {
	submissionId: bigint;
	/** The analyst's explanation, or captured-evidence fallback, for the allegation. */
	analysisText: string;
	reporter: ReporterMetadata;
};

export type ConfirmedWebsiteAbuse = SubmissionReportBase & {
	/**
	 * The captured and classified page first, then the URLs on the same host
	 * that led to it (redirects and the pages whose links were followed). They
	 * all belong to one reported site.
	 */
	urls: string[];
	/**
	 * Screenshots of the captured pages, the classified page first, then the
	 * pages of its flow that led to it in visit order.
	 */
	screenshots?: ReadonlyArray<{ filename: string; png: Buffer }>;
	finding: ReportableWebsiteFinding;
	/** Commands the page tells visitors to paste; the investigation fetches their payloads. */
	pasteCommands?: readonly PasteCommand[];
	/**
	 * A drive-by finding's hidden frame: its source is attached, and the
	 * investigation fetches the stages its loader loads as the browser the
	 * frame was served to.
	 */
	hiddenFrame?: WebsiteHiddenFrame;
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
	allegationCategory?: ValidatedAbuseReportRequest["allegationCategory"];
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
		allegationCategory: params.allegationCategory ?? "phishing",
		description: params.description,
		observedUrls,
		evidence: params.evidence,
		requestPayloadHash: hashStableJson({
			submissionId: params.submissionId.toString(),
			targets: params.targets.map(({ normalizedTarget, targetType, observedUrls: urls }) => ({ normalizedTarget, targetType, urls })),
			description: params.description,
			evidence: params.evidence.map(({ filename, mimeType, sha256 }) => ({ filename, mimeType, sha256 })),
		}),
	};
}

/**
 * The hidden frame of a drive-by finding as a provider can check it: its URL,
 * why no visitor sees it, the hash and source of its document as received,
 * what it loaded and sent, and what its code was found to do.
 */
function hiddenFrameEvidence(frame: WebsiteHiddenFrame): DecodedEvidence {
	const { ref: _ref, ...evidence } = frame;
	const buffer = Buffer.from(JSON.stringify(evidence, null, 2), "utf8");
	return { filename: `hidden-frame-${frame.sha256.slice(0, 16)}.json`, mimeType: "application/json", buffer, sha256: sha256Hex(buffer) };
}

/**
 * Build the website report: the captured site's host, with its URLs as
 * observed evidence. On a shared host the URLs name the one tenant reported.
 */
export async function buildWebsiteAbuseRequest(params: ConfirmedWebsiteAbuse): Promise<ValidatedAbuseReportRequest> {
	const observedUrls = [...new Set(params.urls.map((url) => normalizeObservedUrl(url.trim())))];
	if (new Set(observedUrls.map(websiteSite)).size !== 1) throw new Error("A website report covers the URLs of exactly one captured site.");
	return submissionRequest({
		submissionId: params.submissionId,
		allegationCategory: params.finding.finding,
		description: reportDescription(params.analysisText),
		targets: [target(0, new URL(observedUrls[0]!).hostname, observedUrls)],
		evidence: [
			...(await Promise.all((params.screenshots ?? []).map(({ filename, png }) => screenshotEvidence(filename, png)))).flat(),
			...(params.hiddenFrame ? [hiddenFrameEvidence(params.hiddenFrame)] : []),
		],
		source: { kind: "website", urls: params.urls },
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
 * Accept a confirmed website into the reporting aggregate. The report is held
 * in `investigating` while its evidence is collected (command payloads, the
 * controlled form probe, linked payload-host reports); providers are contacted
 * only once that investigation releases it. A successful return means the
 * durable report and its investigation job exist.
 */
export async function reportConfirmedWebsiteAbuse(params: ConfirmedWebsiteAbuse): Promise<CreatedAbuseReport> {
	const payload: InvestigationJobPayload = {
		submissionId: params.submissionId.toString(),
		pageUrl: params.urls[0]!,
		finding: params.finding,
		pasteCommands: (params.pasteCommands ?? []).map(({ shown, payloadUrls, interpreters }) => ({ shown, payloadUrls, interpreters })),
		...(params.hiddenFrame ? {
			exploitLoader: {
				frameUrl: params.hiddenFrame.url,
				userAgent: params.hiddenFrame.userAgent,
				stageUrls: params.hiddenFrame.signals.stageUrls,
				dataUploads: params.hiddenFrame.signals.dataUploads,
			},
		} : {}),
	};
	const created = await AbuseRepository.createReport({
		request: await buildWebsiteAbuseRequest(params),
		reporter: params.reporter,
		submissionId: params.submissionId,
		investigation: { payload },
	});
	if (created.created) await setInvestigationStatus(params.submissionId, { status: "queued", updatedAt: new Date().toISOString() });
	await enqueueKitSiblingDiscovery(created.reportId, params.submissionId);
	await enqueueRedirectorWatch(created.reportId, params.submissionId);
	return created;
}

export async function reportConfirmedEmailPhishing(params: ConfirmedEmailPhishing): Promise<CreatedAbuseReport> {
	return AbuseRepository.createReport({ request: await buildEmailPhishingRequest(params), reporter: params.reporter, submissionId: params.submissionId });
}
