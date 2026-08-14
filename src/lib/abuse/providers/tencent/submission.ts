import { fetch as proxyFetch } from "netbun";

import { AbuseRepository } from "../../repository";
import type { AbuseArtifact } from "../../schema";
import { providerDefinitionMatchesPin } from "../definition";
import { getProviderProxy, type ProviderProxy } from "../proxy";
import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { routeContext } from "../../worker/shared";
import { getTencentCaptchaCredentials, solveTencentCaptcha, type TencentCaptcha } from "./captcha";
import { TENCENT_PROVIDER } from "./definition";
import {
	buildTencentSubmissionPayload,
	isIntactTencentScreenshotArtifact,
	selectTencentScreenshotArtifact,
	storedTencentSubmissionPayload,
	type TencentScreenshotReference,
	type TencentSubmissionPayload,
} from "./payload";

type TencentCloudSubmissionResponse = {
	code: number;
	msg?: string;
	data?: {
		code?: string;
		error?: string;
		message?: string;
	};
};

type TencentProxyFetch = (input: string | URL | Request, init?: RequestInit & { proxy: string }) => Promise<Response>;

export type TencentSubmissionDependencies = {
	proxy?: () => ProviderProxy;
	captchaSolver?: (proxy: ProviderProxy) => Promise<TencentCaptcha>;
	fetch?: TencentProxyFetch;
};

function parseTencentCloudResponseJson(body: string): TencentCloudSubmissionResponse | undefined {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const response = value as Record<string, unknown>;
	const data = response.data;
	if (typeof response.code !== "number" || (data !== undefined && (!data || typeof data !== "object" || Array.isArray(data)))) return undefined;
	const detail = data as Record<string, unknown> | undefined;
	if (detail && ((detail.code !== undefined && typeof detail.code !== "string")
		|| (detail.error !== undefined && typeof detail.error !== "string")
		|| (detail.message !== undefined && typeof detail.message !== "string"))) return undefined;
	return {
		code: response.code,
		...(typeof response.msg === "string" ? { msg: response.msg } : {}),
		...(detail ? {
			data: {
				...(typeof detail.code === "string" ? { code: detail.code } : {}),
				...(typeof detail.error === "string" ? { error: detail.error } : {}),
				...(typeof detail.message === "string" ? { message: detail.message } : {}),
			},
		} : {}),
	};
}

function tencentResponseDetail(response: TencentCloudSubmissionResponse): string {
	return [response.msg, response.data?.error, response.data?.message].filter((value): value is string => Boolean(value?.trim())).join(" / ") || "Tencent Cloud rejected the report.";
}

/**
 * Only an explicit, well-formed provider result can be treated as a known
 * rejection. Transport failures, malformed JSON, and WAF responses remain
 * ambiguous after the durable pre-call marker.
 */
export async function parseTencentCloudSubmissionResponse(
	response: Pick<Response, "ok" | "status" | "text">,
): Promise<TencentCloudSubmissionResponse> {
	const body = await response.text();
	const json = parseTencentCloudResponseJson(body);
	if (!response.ok) {
		if (json && (json.code !== 0 || json.data?.code !== "0")) {
			throw new ProviderSubmissionRejectedError(`Tencent Cloud abuse report rejected: ${tencentResponseDetail(json)}`);
		}
		throw new Error(`Tencent Cloud abuse report submission failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
	}
	if (!json) throw new Error("Tencent Cloud abuse report submission returned malformed JSON.");
	if (json.code !== 0 || json.data?.code !== "0") {
		throw new ProviderSubmissionRejectedError(`Tencent Cloud abuse report rejected: ${tencentResponseDetail(json)}`);
	}
	return json;
}

/** Build the exact Tencent HTTP form only after a valid token CAPTCHA exists. */
export function buildTencentCloudHttpPayload(params: {
	payload: TencentSubmissionPayload;
	websiteScreenshot: Buffer;
	captcha: TencentCaptcha;
}): Record<string, unknown> {
	if (!Buffer.isBuffer(params.websiteScreenshot) || params.websiteScreenshot.byteLength === 0 || params.websiteScreenshot.byteLength > TENCENT_PROVIDER.evidence.maximumBytes) {
		throw new Error("Tencent Cloud abuse reporting requires a valid PNG screenshot artifact.");
	}
	return {
		action: "createDomainReport",
		payload: {
			captcha: params.captcha,
			formData: {
				domain: params.payload.target.registrableDomain,
				url: params.payload.target.observedUrl,
				describe: params.payload.report.explanation,
				...(params.payload.report.legalBrandUrl ? { infringedUrl: params.payload.report.legalBrandUrl } : {}),
				category: ["Phishing"],
				name: TENCENT_PROVIDER.reporter.name,
				email: TENCENT_PROVIDER.reporter.email,
				privacyCheckbox1: true,
				privacyCheckbox2: true,
				country_code: TENCENT_PROVIDER.reporter.countryCode,
				country_name: TENCENT_PROVIDER.reporter.countryName,
				fileBase64: params.websiteScreenshot.toString("base64"),
				filename: params.payload.screenshot.filename,
			},
		},
	};
}

function sameScreenshot(reference: TencentScreenshotReference, artifact: Pick<AbuseArtifact, "id" | "name" | "kind" | "mimeType" | "sha256" | "size" | "blob">): boolean {
	return isIntactTencentScreenshotArtifact(artifact)
		&& artifact.id.toString() === reference.artifactId
		&& artifact.name === reference.name
		&& artifact.mimeType === reference.mimeType
		&& artifact.sha256.toLowerCase() === reference.sha256
		&& artifact.size === reference.size
		&& artifact.blob.byteLength === reference.size;
}

/**
 * Construct a provider-owned report draft before generic execution records an
 * irreversible submission marker. Configuration is intentionally validated
 * here so a missing proxy or DBC credential never turns into a false unknown
 * external state.
 */
export async function prepareTencentSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const { route, report, target, evidenceArtifacts } = await routeContext(context.routeId);
	if (route.routeType !== "provider_submission" || route.providerRegistryKey !== TENCENT_PROVIDER.key || target.targetType !== "domain") {
		return { outcome: "insufficient_evidence", reason: "tencent_requires_a_domain_target" };
	}
	if (!providerDefinitionMatchesPin(TENCENT_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "tencent_provider_definition_pin_mismatch" };
	}
	const observedUrl = target.observedUrls[0];
	if (!observedUrl) return { outcome: "insufficient_evidence", reason: "tencent_requires_an_observed_url" };
	const screenshot = selectTencentScreenshotArtifact(evidenceArtifacts);
	if (!screenshot) return { outcome: "insufficient_evidence", reason: "tencent_requires_a_valid_png_screenshot" };

	// Both settings are runtime secrets, so validate but never retain them in the
	// payload that is stored with the provider run.
	getProviderProxy("Tencent Cloud abuse reporting");
	getTencentCaptchaCredentials();
	const payload = buildTencentSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl,
		description: report.description,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		screenshot,
	});
	if (!payload) return { outcome: "insufficient_evidence", reason: "tencent_report_payload_invalid" };
	return { outcome: "ready", payload };
}

/** Perform the one Tencent provider request from the durable, pinned draft. */
export async function submitTencentSubmission(
	context: ProviderSubmissionContext,
	dependencies: TencentSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const payload = storedTencentSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Tencent submission payload is malformed.");
	const { route, report, target } = await routeContext(context.routeId);
	if (route.routeType !== "provider_submission" || route.providerRegistryKey !== TENCENT_PROVIDER.key
		|| !providerDefinitionMatchesPin(TENCENT_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)
		|| target.targetType !== "domain" || target.normalizedTarget !== payload.target.normalizedTarget
		|| !target.observedUrls.includes(payload.target.observedUrl)) {
		throw new Error("The persisted Tencent submission payload no longer matches its route.");
	}
	const expectedExplanation = payload.report.explanation;
	const rebuilt = buildTencentSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl: payload.target.observedUrl,
		description: report.description,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		screenshot: payload.screenshot,
	});
	if (!rebuilt || rebuilt.report.explanation !== expectedExplanation || rebuilt.report.legalBrandUrl !== payload.report.legalBrandUrl) {
		throw new Error("The persisted Tencent submission draft no longer matches the report evidence.");
	}

	let screenshotId: bigint;
	try {
		screenshotId = BigInt(payload.screenshot.artifactId);
	} catch {
		throw new Error("The persisted Tencent screenshot artifact ID is invalid.");
	}
	const artifact = await AbuseRepository.getArtifact(report.id, screenshotId);
	if (!artifact || !sameScreenshot(payload.screenshot, artifact)) {
		throw new Error("The persisted Tencent screenshot artifact no longer matches its immutable reference.");
	}

	const proxy = (dependencies.proxy ?? (() => getProviderProxy("Tencent Cloud abuse reporting")))();
	const captcha = await (dependencies.captchaSolver ?? solveTencentCaptcha)(proxy);
	const requestPayload = buildTencentCloudHttpPayload({ payload, websiteScreenshot: artifact.blob, captcha });
	const request = dependencies.fetch ?? (proxyFetch as TencentProxyFetch);
	const response = await request(TENCENT_PROVIDER.submissionUrl, {
		headers: {
			accept: "application/json, text/plain, */*",
			"accept-language": "en-US,en;q=0.9",
			"content-type": "application/json",
			priority: "u=1, i",
			"sec-ch-ua": '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"macOS"',
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			cookie: "intl_language=en; language=en",
			Referer: TENCENT_PROVIDER.reportPageUrl,
		},
		body: JSON.stringify(requestPayload),
		method: "POST",
		proxy: proxy.url,
	});
	const result = await parseTencentCloudSubmissionResponse(response);
	return {
		confirmationText: result.msg?.trim() || "Tencent Cloud accepted the domain-abuse report.",
		finalUrl: TENCENT_PROVIDER.reportPageUrl,
		submittedTargets: [payload.target.normalizedTarget],
	};
}
