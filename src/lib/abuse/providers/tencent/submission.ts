import { fetch as proxyFetch } from "netbun";

import { captchaCredentialsPresent, solveCaptchaToken } from "../kit/captcha";
import { createDraft, type RouteDeps } from "../kit/draft";
import { evidenceReferenceOf, loadEvidenceFile } from "../kit/evidence";
import { getProviderProxy, type ProviderProxy } from "../proxy";
import { ProviderSubmissionRejectedError, type ProviderSubmissionContext, type ProviderSubmissionSuccess } from "../submission_contracts";
import { TENCENT_PROVIDER } from "./definition";
import {
	buildTencentSubmissionPayload,
	storedTencentSubmissionPayload,
	TENCENT_EVIDENCE_CONTRACT,
	type TencentSubmissionPayload,
} from "./payload";

/** Tencent's token CAPTCHA reply requires both ticket and randstr. */
export type TencentCaptcha = { ret: 0; ticket: string; randstr: string; [key: string]: unknown };

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

export type TencentSubmissionDependencies = RouteDeps & {
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
				category: [params.payload.report.category],
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

const draft = createDraft({
	definition: TENCENT_PROVIDER,
	reasonPrefix: "tencent",
	targetTypes: ["domain"],
	targetReason: "tencent_requires_a_domain_target",
	read: storedTencentSubmissionPayload,
	// What the stored draft holds (its URL, its screenshot) is not reselected.
	input: ({ report, target, evidenceArtifacts }, stored: TencentSubmissionPayload | undefined) => {
		const observedUrl = stored?.target.observedUrl ?? target.observedUrls[0];
		const screenshot = evidenceReferenceOf(TENCENT_EVIDENCE_CONTRACT, evidenceArtifacts, stored && { evidence: stored.screenshot });
		// Both settings are runtime secrets: validated here, never kept in the stored payload, and only once the draft is otherwise possible.
		if (!stored && observedUrl && screenshot) {
			getProviderProxy("Tencent Cloud abuse reporting");
			if (!captchaCredentialsPresent()) throw new Error("Tencent Cloud abuse reporting requires DEATHBYCAPTCHA_USERNAME and DEATHBYCAPTCHA_PASSWORD.");
		}
		return {
			target: target.normalizedTarget,
			observedUrl: observedUrl ?? "",
			description: report.description,
			allegationCategory: report.allegationCategory,
			...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
			screenshot,
		};
	},
	admit: (_data, input) => !input.observedUrl ? "tencent_requires_an_observed_url" : !input.screenshot ? "tencent_requires_a_valid_png_screenshot" : undefined,
	build: buildTencentSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/** Check the route and build the durable draft before any provider call; configuration problems surface here, never as a false unknown external state. */
export const prepareTencentSubmission = draft.prepare;

/** The stored draft, checked against its route and rebuilt from the current report; with its screenshot's bytes. */
export async function verifiedTencentDraft(context: ProviderSubmissionContext, dependencies: RouteDeps = {}) {
	const { payload, data } = await draft.verify(context, dependencies);
	const { bytes } = await loadEvidenceFile({ reference: payload.screenshot, contract: TENCENT_EVIDENCE_CONTRACT, reportId: data.report.id, label: "Tencent screenshot" });
	return { payload, bytes };
}

/** Validate the exact token shape Tencent's form expects from the solver. */
export function parseTencentCaptchaSolution(value: string): TencentCaptcha {
	let result: unknown;
	try {
		result = JSON.parse(value);
	} catch {
		throw new Error("Tencent CAPTCHA solver returned malformed JSON.");
	}
	if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Tencent CAPTCHA solver returned an invalid result.");
	const captcha = result as Record<string, unknown>;
	if (captcha.ret !== 0 || typeof captcha.ticket !== "string" || !captcha.ticket.trim() || typeof captcha.randstr !== "string" || !captcha.randstr.trim()) {
		throw new Error("Tencent CAPTCHA solving failed.");
	}
	return captcha as TencentCaptcha;
}

/** The documented type-23 Tencent token flow through the proxy the form is filed from. */
const solveTencentCaptcha = async (proxy: ProviderProxy, signal?: AbortSignal) => parseTencentCaptchaSolution(await solveCaptchaToken({
	type: TENCENT_PROVIDER.captcha.type,
	parametersField: "tencent_params",
	parameters: { proxy: proxy.url, proxytype: proxy.captchaType, appid: TENCENT_PROVIDER.captcha.appId, pageurl: TENCENT_PROVIDER.reportPageUrl },
}, signal));

/** Perform the one Tencent provider request from the durable, pinned draft. */
export async function submitTencentSubmission(
	context: ProviderSubmissionContext,
	dependencies: TencentSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const { payload, bytes } = await verifiedTencentDraft(context, dependencies);
	const proxy = (dependencies.proxy ?? (() => getProviderProxy("Tencent Cloud abuse reporting")))();
	const captcha = await (dependencies.captchaSolver ?? ((candidate) => solveTencentCaptcha(candidate, context.signal)))(proxy);
	const requestPayload = buildTencentCloudHttpPayload({ payload, websiteScreenshot: bytes, captcha });
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
		...(context.signal ? { signal: context.signal } : {}),
	});
	const result = await parseTencentCloudSubmissionResponse(response);
	return {
		confirmationText: result.msg?.trim() || "Tencent Cloud accepted the domain-abuse report.",
		finalUrl: TENCENT_PROVIDER.reportPageUrl,
		submittedTargets: [payload.target.normalizedTarget],
	};
}
