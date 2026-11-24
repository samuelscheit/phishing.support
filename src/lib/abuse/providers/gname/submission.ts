import type { Page } from "rebrowser-puppeteer-core";

import { getBrowser } from "../../../browser";
import { waitForCaptchaOutcome } from "../../../browser/captcha_state";
import { asRecord, parseJsonRecord } from "../../../util/values";
import { abuseEmailCaseUrl } from "../../mail/draft";
import { createDraft, type VerifiedOf, type RouteDeps } from "../kit/draft";
import { evidenceReferenceOf, evidenceFileOf, type EvidenceDependencies } from "../kit/evidence";
import { preparedState, withPreflight } from "../kit/session";
import { snippet } from "../../../util/text";
import { mailedCodeReader, type MailedCodeReader } from "../kit/mailed_code";
import { ProviderSubmissionRejectedError, type ProviderSubmissionContext, type ProviderSubmissionPreflight, type ProviderSubmissionSuccess } from "../submission_contracts";
import { GNAME_PROVIDER, type GnameComplaintKind } from "./definition";
import {
	buildGnameSubmissionPayload,
	gnameDomainEntry,
	GNAME_EVIDENCE_CONTRACT,
	storedGnameSubmissionPayload,
	type GnameSubmissionPayload,
} from "./payload";

/**
 * GNAME's API answers HTTP 200 with `code` 1 on success (sometimes the string
 * "1"); anything else names the failure in `msg`. `-2` lists per-domain
 * refusals in `data`, `-105001` asks for the slider.
 */
export type GnameResponse = { code?: number | string; msg?: string; data?: unknown };

export type GnameUpload = { filename: string; mimeType: string; base64: string };

/**
 * One visitor session on GNAME's form page. The form's calls carry its
 * session cookie and a rotating upload token (`UINFO.csrf_token`) only a page
 * on www.gname.com holds, so every call runs there, through the page's own
 * jQuery, exactly as the form makes it.
 */
export type GnameSession = {
	post(path: string, data: Record<string, unknown>): Promise<GnameResponse>;
	upload(lx: number, file: GnameUpload): Promise<GnameResponse>;
	/** Ask for the mailed code; the browser's solver passes the form's slider when it demands one. */
	requestCode(email: string, signal?: AbortSignal): Promise<GnameResponse>;
	close(): Promise<void>;
};

export type GnameDependencies = RouteDeps & {
	openSession?: (kind: GnameComplaintKind) => Promise<GnameSession>;
	readCode?: MailedCodeReader;
	getArtifact?: EvidenceDependencies["getArtifact"];
	now?: () => Date;
};

type GnamePreflightState = { session: GnameSession; code: string; pics: string[] };

/** How long `send_email` may take to answer, the browser's solver passing its slider (refused tracks included) on the way. */
const CODE_RESPONSE_TIMEOUT_MS = 120_000;

function gnameSucceeded(response: GnameResponse): boolean {
	return String(response.code) === "1";
}

function failure(response: GnameResponse): string {
	return `${response.msg || "no message"} (code ${String(response.code ?? "none")})`;
}

function parsedResponse(path: string, status: number, text: string): GnameResponse {
	const parsed = parseJsonRecord(text) as GnameResponse | undefined;
	if (status < 200 || status >= 300 || !parsed) throw new Error(`GNAME ${path} failed with HTTP ${status}: ${snippet(text)}`);
	return parsed;
}

type CodeWindow = { __gnameCode?: GnameResponse | { error: string } };

/**
 * The form's own `send_email`: it posts, meets `-105001`, opens the slider,
 * and posts again with the slider's token. The browser's solver drags the
 * slider (again, if the widget refuses a track); the answer is whatever
 * `send_email` finally hands its callback.
 */
async function requestGnameCodeOnPage(page: Page, email: string, signal: AbortSignal | undefined, timeoutMs = CODE_RESPONSE_TIMEOUT_MS): Promise<GnameResponse> {
	await page.evaluate((address) => {
		const target = window as unknown as CodeWindow & { send_email?: (element: Element, data: Record<string, string>, callback: (response: unknown) => void) => void };
		target.__gnameCode = undefined;
		if (typeof target.send_email !== "function") {
			target.__gnameCode = { error: "the page has no send_email" };
			return;
		}
		target.send_email(document.body, { lx: "lyts", email: address }, (response) => {
			target.__gnameCode = response as GnameResponse;
		});
	}, email);
	let response: GnameResponse | { error: string } | undefined;
	// A look that fails (the page navigating under it) is no answer yet.
	const answered = async () => (response = await page.evaluate(() => (window as unknown as CodeWindow).__gnameCode).catch(() => undefined)) !== undefined;
	await waitForCaptchaOutcome(page, answered, { label: "GNAME's code request", timeoutMs, ...(signal ? { signal } : {}) });
	if (!response || "error" in response) throw new Error(`GNAME's form could not request a code: ${response?.error ?? "no answer"}`);
	return response;
}

/** A Fabric browser page on the form for this complaint type, over the reporting egress. */
async function openGnameBrowserSession(kind: GnameComplaintKind): Promise<GnameSession> {
	const browser = await getBrowser("reporting");
	try {
		const page = await browser.defaultBrowserContext().newPage();
		await page.goto(GNAME_PROVIDER.complaintTypes[kind].pageUrl, { waitUntil: "networkidle2", timeout: 60_000 });
		return {
			post: async (path, data) => {
				const result = await page.evaluate((url, body) => new Promise<{ status: number; text: string }>((resolve) => {
					const jquery = (window as unknown as { layui?: { $?: { ajax(options: Record<string, unknown>): void } } }).layui?.$;
					if (!jquery) {
						resolve({ status: 0, text: "the page has no jQuery" });
						return;
					}
					jquery.ajax({
						url,
						type: "post",
						data: body,
						dataType: "text",
						timeout: 120_000,
						success: (text: string, _status: string, xhr: XMLHttpRequest) => resolve({ status: xhr.status, text }),
						error: (xhr: XMLHttpRequest) => resolve({ status: xhr.status, text: xhr.responseText ?? "" }),
					});
				}), path, data);
				return parsedResponse(path, result.status, result.text);
			},
			upload: async (lx, file) => {
				const result = await page.evaluate(async (complaintType, upload) => {
					const holder = window as unknown as { UINFO?: { csrf_token?: string } };
					const bytes = Uint8Array.from(atob(upload.base64), (character) => character.charCodeAt(0));
					const form = new FormData();
					form.append("file", new Blob([bytes], { type: upload.mimeType }), upload.filename);
					form.append("wj", "pics");
					form.append("lx", String(complaintType));
					form.append("uptoken", holder.UINFO?.csrf_token ?? "");
					const response = await fetch("/request/lyts_upfile2", { method: "POST", credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" }, body: form });
					const text = await response.text();
					// The form keeps the token each upload hands back for the next one.
					try {
						const token = JSON.parse(text)?.data?.uptoken;
						if (typeof token === "string" && holder.UINFO) holder.UINFO.csrf_token = token;
					} catch {
						// Reported below.
					}
					return { status: response.status, text };
				}, lx, file);
				return parsedResponse("lyts_upfile2", result.status, result.text);
			},
			requestCode: (email, signal) => requestGnameCodeOnPage(page, email, signal),
			close: () => browser.close().catch(() => undefined),
		};
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}

export const gnameDraft = createDraft({
	definition: GNAME_PROVIDER,
	reasonPrefix: "gname",
	targetTypes: ["domain"],
	targetReason: "gname_requires_a_domain_target",
	read: storedGnameSubmissionPayload,
	input: ({ report, target, evidenceArtifacts }, stored: GnameSubmissionPayload | undefined) => ({
		target: target.normalizedTarget,
		observedUrl: stored?.target.observedUrl ?? target.observedUrls[0] ?? "",
		description: report.description,
		allegationCategory: report.allegationCategory,
		// The imitated brand's site, or for a page that imitates none the case page holding the evidence.
		legalBrandUrl: report.legalBrandUrl ?? abuseEmailCaseUrl(report.submissionId) ?? "",
		evidence: evidenceReferenceOf(GNAME_EVIDENCE_CONTRACT, evidenceArtifacts, stored),
	}),
	admit: (_data, input) => !input.observedUrl ? "gname_requires_an_observed_url" : !input.legalBrandUrl ? "gname_requires_a_reference_website" : !input.evidence ? "gname_requires_a_screenshot" : undefined,
	build: buildGnameSubmissionPayload,
	targetOf: (payload) => payload.target.host,
});

/**
 * Before the marker: upload the screenshot, pass the slider, and read the
 * mailed code. An uploaded file and a sent code file no complaint, so every
 * failure here is a safe retry.
 */
export async function prepareGnameExternalSubmission(context: ProviderSubmissionContext, { payload, data }: VerifiedOf<typeof gnameDraft>, dependencies: GnameDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const { bytes } = await evidenceFileOf(GNAME_EVIDENCE_CONTRACT, "GNAME", payload.evidence, data, dependencies);
	const { lx } = GNAME_PROVIDER.complaintTypes[payload.report.kind];
	return withPreflight(() => (dependencies.openSession ?? openGnameBrowserSession)(payload.report.kind), async (session) => {
		const uploaded = await session.upload(lx, { filename: payload.evidence.filename, mimeType: payload.evidence.mimeType, base64: bytes.toString("base64") });
		const path = asRecord(uploaded.data)?.path;
		if (!gnameSucceeded(uploaded) || typeof path !== "string" || !path) throw new Error(`GNAME screenshot upload failed: ${failure(uploaded)}`);
		const requestedAt = (dependencies.now ?? (() => new Date()))();
		const sent = await session.requestCode(GNAME_PROVIDER.reporter.email, context.signal);
		if (!gnameSucceeded(sent)) throw new Error(`GNAME did not send its verification code: ${failure(sent)}`);
		const code = await (dependencies.readCode ?? mailedCodeReader(GNAME_PROVIDER.codeMail))(requestedAt, context.signal);
		return { session, code, pics: [path] } satisfies GnamePreflightState;
	});
}

/** `lyts_add`'s fields, as the form's submit handler sends them. */
export function gnameComplaintBody(payload: GnameSubmissionPayload, code: string, pics: readonly string[]): Record<string, unknown> {
	const type = GNAME_PROVIDER.complaintTypes[payload.report.kind];
	return {
		lx: type.lx,
		sm: payload.report.description,
		zmwj: "",
		...(type.legalBrandUrl ? { wzdz: payload.report.legalBrandUrl } : {}),
		name: GNAME_PROVIDER.reporter.name,
		email: GNAME_PROVIDER.reporter.email,
		eyzm: code,
		ymlb: [gnameDomainEntry(payload.target)],
		pics: [...pics],
	};
}

function domainRefusals(data: unknown): string {
	if (!Array.isArray(data)) return "";
	const refusals = data.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
		.map((entry) => `${String(entry.ym ?? "")}: ${String(entry.msg ?? "")}`);
	return refusals.length ? ` (${refusals.join("; ")})` : "";
}

/** The one irreversible call: `lyts_add` with the pinned draft and the preflight's code and upload. */
export async function submitGnameSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight): Promise<ProviderSubmissionSuccess> {
	const payload = gnameDraft.stored(context);
	const state = preparedState<GnamePreflightState>(preflight, (candidate) => !!candidate.session && typeof candidate.code === "string" && !!candidate.code && Array.isArray(candidate.pics) && candidate.pics.length > 0, "GNAME submission requires a prepared verification code, an uploaded screenshot, and its browser session.");
	const created = await state.session.post("/request/lyts_add", gnameComplaintBody(payload, state.code, state.pics));
	// GNAME names every refusal; a named refusal filed nothing.
	if (!gnameSucceeded(created)) throw new ProviderSubmissionRejectedError(`GNAME rejected the report: ${failure(created)}${domainRefusals(created.data)}`);
	const caseNumber = typeof created.data === "string" || typeof created.data === "number" ? String(created.data) : "";
	return {
		...(caseNumber ? { confirmationId: caseNumber } : {}),
		confirmationText: `GNAME accepted the complaint${caseNumber ? ` (case ${caseNumber})` : ""}.`,
		finalUrl: GNAME_PROVIDER.complaintTypes[payload.report.kind].pageUrl,
		submittedTargets: [payload.target.host],
	};
}
