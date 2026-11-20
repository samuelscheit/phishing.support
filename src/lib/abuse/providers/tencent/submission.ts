import { withPreflight, preparedState } from "../kit/session";
import { createDraft, type RouteDeps, type VerifiedOf } from "../kit/draft";
import { evidenceFileOf, evidenceReferenceOf, type EvidenceDependencies } from "../kit/evidence";
import { snippet } from "../../../util/text";
import { ProviderSubmissionRejectedError, type ProviderSubmissionContext, type ProviderSubmissionPreflight, type ProviderSubmissionSuccess } from "../submission_contracts";
import { openTencentForm, type TencentCapturedRequest, type TencentFormInput, type TencentFormSession } from "./browser";
import { TENCENT_PROVIDER } from "./definition";
import {
	buildTencentSubmissionPayload,
	storedTencentSubmissionPayload,
	TENCENT_EVIDENCE_CONTRACT,
	type TencentSubmissionPayload,
} from "./payload";
import { asRecord, parseJsonRecord } from "../../../util/values";

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

export type TencentSubmissionDependencies = RouteDeps & EvidenceDependencies & {
	/** Opens the browser page on the form; the real one is a Fabric Chrome over the direct egress. */
	open?: (signal: AbortSignal | undefined) => Promise<TencentFormSession>;
};

function parseTencentCloudResponseJson(body: string): TencentCloudSubmissionResponse | undefined {
	const response = parseJsonRecord(body);
	if (!response) return undefined;
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
		throw new Error(`Tencent Cloud abuse report submission failed with HTTP ${response.status}: ${snippet(body, 500)}`);
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

export const tencentDraft = createDraft({
	definition: TENCENT_PROVIDER,
	reasonPrefix: "tencent",
	targetTypes: ["domain"],
	targetReason: "tencent_requires_a_domain_target",
	read: storedTencentSubmissionPayload,
	// What the stored draft holds (its URL, its screenshot) is not reselected.
	input: ({ report, target, evidenceArtifacts }, stored: TencentSubmissionPayload | undefined) => {
		const observedUrl = stored?.target.observedUrl ?? target.observedUrls[0];
		const screenshot = evidenceReferenceOf(TENCENT_EVIDENCE_CONTRACT, evidenceArtifacts, stored && { evidence: stored.screenshot });
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

/** The form values of a verified draft, as the page's fields take them. */
function formInputOf(payload: TencentSubmissionPayload, screenshot: Buffer): TencentFormInput {
	return {
		domain: payload.target.registrableDomain,
		url: payload.target.observedUrl,
		...(payload.report.legalBrandUrl ? { infringedUrl: payload.report.legalBrandUrl } : {}),
		category: payload.report.category,
		describe: payload.report.explanation,
		name: TENCENT_PROVIDER.reporter.name,
		email: TENCENT_PROVIDER.reporter.email,
		countryName: TENCENT_PROVIDER.reporter.countryName,
		screenshot: { filename: payload.screenshot.filename, bytes: screenshot },
	};
}

/**
 * Why a request the page made is not the filing the draft calls for, if it is
 * not: wrong endpoint, no passed captcha, or a body whose form values differ
 * from the verified draft (the page's own form is what built it).
 */
export function tencentCapturedRequestProblem(request: TencentCapturedRequest, payload: TencentSubmissionPayload, screenshot: Buffer): string | undefined {
	const url = new URL(request.url);
	const endpoint = new URL(TENCENT_PROVIDER.submissionUrl);
	if (request.method !== "POST" || url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) return `it is a ${request.method} to ${url.origin}${url.pathname}`;
	const body = parseJsonRecord(request.body);
	const inner = asRecord(body?.payload);
	const captcha = asRecord(inner?.captcha) as Partial<TencentCaptcha> | undefined;
	if (body?.action !== "createDomainReport" || !captcha || captcha.ret !== 0 || typeof captcha.ticket !== "string" || !captcha.ticket.trim() || typeof captcha.randstr !== "string" || !captcha.randstr.trim()) return "its captcha ticket is missing";
	const expected = buildTencentCloudHttpPayload({ payload, websiteScreenshot: screenshot, captcha: captcha as TencentCaptcha }) as { payload: { formData: unknown } };
	if (JSON.stringify(sortedKeys(inner?.formData)) !== JSON.stringify(sortedKeys(expected.payload.formData))) return "its form values differ from the verified draft";
	return undefined;
}

function sortedKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortedKeys);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : 1).map(([key, entry]) => [key, sortedKeys(entry)]));
	return value;
}

/** What the one filing request needs, kept in memory from before the marker. */
type TencentPreflightState = { payload: TencentSubmissionPayload; request: TencentCapturedRequest; session: TencentFormSession };

/**
 * Before the marker, with nothing filed: the verified draft is filled into
 * the live form in a browser, its slider puzzle is solved by image analysis,
 * and the form's own filing request, ticket included, is caught and aborted.
 * Any failure closes the browser.
 */
export async function prepareTencentExternalSubmission(
	context: ProviderSubmissionContext,
	{ payload, data }: VerifiedOf<typeof tencentDraft>,
	dependencies: TencentSubmissionDependencies = {},
): Promise<ProviderSubmissionPreflight> {
	const { bytes } = await evidenceFileOf(TENCENT_EVIDENCE_CONTRACT, "Tencent screenshot", payload.screenshot, data, dependencies);
	return withPreflight(() => (dependencies.open ?? openTencentForm)(context.signal), async (session): Promise<TencentPreflightState> => {
		const request = await session.captureRequest(formInputOf(payload, bytes));
		const problem = tencentCapturedRequestProblem(request, payload, bytes);
		if (problem) throw new Error(`Tencent Cloud form's request was not sent: ${problem}.`);
		return { payload, request, session };
	});
}

/** The one Tencent provider request: the caught request, sent from the page that made it. */
export async function submitTencentSubmission(
	_context: ProviderSubmissionContext,
	preflight: ProviderSubmissionPreflight,
): Promise<ProviderSubmissionSuccess> {
	const { payload, request, session } = preparedState<TencentPreflightState>(preflight, (state) => !!state.payload && !!state.request && !!state.session, "Tencent submission requires its prepared draft and caught request.");
	const { status, text } = await session.send(request);
	const result = await parseTencentCloudSubmissionResponse({ ok: status >= 200 && status < 300, status, text: async () => text });
	return {
		confirmationText: result.msg?.trim() || "Tencent Cloud accepted the domain-abuse report.",
		finalUrl: TENCENT_PROVIDER.reportPageUrl,
		submittedTargets: [payload.target.normalizedTarget],
	};
}
