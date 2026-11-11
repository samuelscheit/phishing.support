import type { Page } from "rebrowser-puppeteer-core";

import { getBrowser } from "../../../browser";
import { abuseEmailCaseUrl } from "../../mail/draft";
import { AbuseRepository } from "../../repository";
import { dragSliderToEnd } from "../../captcha/slider_drag";
import { recordValue, routeContext } from "../../worker/shared";
import { providerDefinitionMatchesPin } from "../definition";
import { providerEvidenceImageArtifactMatches } from "../evidence_image";
import { mailedCodeReader, type MailedCodeReader } from "../mailed_code";
import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreflight,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { GNAME_PROVIDER, type GnameComplaintKind } from "./definition";
import {
	buildGnameSubmissionPayload,
	gnameDomainEntry,
	GNAME_EVIDENCE_CONTRACT,
	selectGnameEvidenceArtifact,
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
	/** Ask for the mailed code, passing the form's slider when it demands one. */
	requestCode(email: string): Promise<GnameResponse>;
	close(): Promise<void>;
};

export type GnameDependencies = {
	openSession?: (kind: GnameComplaintKind) => Promise<GnameSession>;
	readCode?: MailedCodeReader;
	loadRouteContext?: typeof routeContext;
	getArtifact?: typeof AbuseRepository.getArtifact;
	now?: () => Date;
};

type GnamePreflightState = { session: GnameSession; code: string; pics: string[] };

const SLIDER_ATTEMPTS = 3;
const CODE_RESPONSE_TIMEOUT_MS = 30_000;

export function gnameSucceeded(response: GnameResponse): boolean {
	return String(response.code) === "1";
}

function failure(response: GnameResponse): string {
	return `${response.msg || "no message"} (code ${String(response.code ?? "none")})`;
}

function parsedResponse(path: string, status: number, text: string): GnameResponse {
	let parsed: GnameResponse | undefined;
	try {
		parsed = recordValue(JSON.parse(text)) as GnameResponse | undefined;
	} catch {
		parsed = undefined;
	}
	if (status < 200 || status >= 300 || !parsed) throw new Error(`GNAME ${path} failed with HTTP ${status}: ${text.slice(0, 300)}`);
	return parsed;
}

type CodeWindow = { __gnameCode?: GnameResponse | { error: string } };

/**
 * The form's own `send_email`: it posts, meets `-105001`, opens the slider,
 * and posts again with the slider's token. The drag happens here, a few
 * times if the widget refuses a track; the answer is whatever `send_email`
 * finally hands its callback.
 */
export async function requestGnameCodeOnPage(page: Page, email: string): Promise<GnameResponse> {
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
	const answer = () => page.evaluate(() => (window as unknown as CodeWindow).__gnameCode);
	const sliderShown = () => page.$eval(GNAME_PROVIDER.slider.handle, (element) => (element as HTMLElement).offsetParent !== null).catch(() => false);
	for (let attempt = 0; attempt <= SLIDER_ATTEMPTS; attempt++) {
		const deadline = Date.now() + CODE_RESPONSE_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const response = await answer();
			if (response) {
				if ("error" in response) throw new Error(`GNAME's form could not request a code: ${response.error}`);
				return response;
			}
			if (await sliderShown()) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (!(await sliderShown())) break;
		if (attempt === SLIDER_ATTEMPTS) break;
		await dragSliderToEnd(page, GNAME_PROVIDER.slider);
		// A passed slider closes; a refused one resets its handle for another try.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	const response = await answer();
	if (response && !("error" in response)) return response;
	throw new Error(`GNAME's slider did not pass after ${SLIDER_ATTEMPTS} drags, so no code was sent.`);
}

/** A Fabric browser page on the form for this complaint type, over the reporting egress. */
export async function openGnameBrowserSession(kind: GnameComplaintKind): Promise<GnameSession> {
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
			requestCode: (email) => requestGnameCodeOnPage(page, email),
			close: () => browser.close().catch(() => undefined),
		};
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}

async function routeFor(context: ProviderSubmissionContext, dependencies: GnameDependencies) {
	const loaded = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (loaded.route.routeType !== "provider_submission" || loaded.route.providerRegistryKey !== GNAME_PROVIDER.key || loaded.target.targetType !== "domain") {
		throw new Error("GNAME reporting requires a domain target on its own route.");
	}
	return loaded;
}

/** Build the pinned draft before the marker; nothing is sent to GNAME here. */
export async function prepareGnameSubmission(context: ProviderSubmissionContext, dependencies: GnameDependencies = {}): Promise<ProviderSubmissionPreparation> {
	const { route, report, target, evidenceArtifacts } = await routeFor(context, dependencies);
	if (!providerDefinitionMatchesPin(GNAME_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "gname_provider_definition_pin_mismatch" };
	}
	const observedUrl = target.observedUrls[0];
	if (!observedUrl) return { outcome: "insufficient_evidence", reason: "gname_requires_an_observed_url" };
	// The imitated brand's site, or for a page that imitates none the case page holding the evidence.
	const legalBrandUrl = report.legalBrandUrl ?? abuseEmailCaseUrl(report.submissionId);
	if (!legalBrandUrl) return { outcome: "insufficient_evidence", reason: "gname_requires_a_reference_website" };
	const evidence = selectGnameEvidenceArtifact(evidenceArtifacts);
	if (!evidence) return { outcome: "insufficient_evidence", reason: "gname_requires_a_screenshot" };
	const payload = buildGnameSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl,
		description: report.description,
		allegationCategory: report.allegationCategory,
		legalBrandUrl,
		evidence,
	});
	return payload ? { outcome: "ready", payload } : { outcome: "insufficient_evidence", reason: "gname_report_payload_invalid" };
}

/**
 * Before the marker: upload the screenshot, pass the slider, and read the
 * mailed code. An uploaded file and a sent code file no complaint, so every
 * failure here is a safe retry.
 */
export async function prepareGnameExternalSubmission(context: ProviderSubmissionContext, dependencies: GnameDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const payload = storedGnameSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted GNAME submission payload is malformed.");
	const { report } = await routeFor(context, dependencies);
	const artifact = await (dependencies.getArtifact ?? AbuseRepository.getArtifact)(report.id, BigInt(payload.evidence.artifactId));
	if (!artifact || !providerEvidenceImageArtifactMatches(payload.evidence, artifact, GNAME_EVIDENCE_CONTRACT)) {
		throw new Error("The persisted GNAME evidence artifact no longer matches its immutable reference.");
	}
	const { lx } = GNAME_PROVIDER.complaintTypes[payload.report.kind];
	const session = await (dependencies.openSession ?? openGnameBrowserSession)(payload.report.kind);
	try {
		const uploaded = await session.upload(lx, { filename: payload.evidence.filename, mimeType: payload.evidence.mimeType, base64: Buffer.from(artifact.blob).toString("base64") });
		const path = recordValue(uploaded.data)?.path;
		if (!gnameSucceeded(uploaded) || typeof path !== "string" || !path) throw new Error(`GNAME screenshot upload failed: ${failure(uploaded)}`);
		const requestedAt = (dependencies.now ?? (() => new Date()))();
		const sent = await session.requestCode(GNAME_PROVIDER.reporter.email);
		if (!gnameSucceeded(sent)) throw new Error(`GNAME did not send its verification code: ${failure(sent)}`);
		const code = await (dependencies.readCode ?? mailedCodeReader(GNAME_PROVIDER.codeMail))(requestedAt, context.signal);
		const state: GnamePreflightState = { session, code, pics: [path] };
		return { state, dispose: () => session.close() };
	} catch (error) {
		await session.close();
		throw error;
	}
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
	const refusals = data.map((entry) => recordValue(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
		.map((entry) => `${String(entry.ym ?? "")}: ${String(entry.msg ?? "")}`);
	return refusals.length ? ` (${refusals.join("; ")})` : "";
}

/** The one irreversible call: `lyts_add` with the pinned draft and the preflight's code and upload. */
export async function submitGnameSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined): Promise<ProviderSubmissionSuccess> {
	const payload = storedGnameSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted GNAME submission payload is malformed.");
	const state = preflight?.state as GnamePreflightState | undefined;
	if (!state?.session || typeof state.code !== "string" || !state.code || !Array.isArray(state.pics) || state.pics.length === 0) {
		throw new Error("GNAME submission requires a prepared verification code, an uploaded screenshot, and its browser session.");
	}
	const created = await state.session.post("/request/lyts_add", gnameComplaintBody(payload, state.code, state.pics));
	// GNAME names every refusal; a named refusal filed nothing.
	if (!gnameSucceeded(created)) throw new ProviderSubmissionRejectedError(`GNAME rejected the report: ${failure(created)}${domainRefusals(created.data)}`);
	const caseNumber = typeof created.data === "string" || typeof created.data === "number" ? String(created.data) : "";
	return {
		...(caseNumber ? { confirmationId: caseNumber } : {}),
		confirmationText: `GNAME accepted the complaint${caseNumber ? ` (case ${caseNumber})` : ""}.`,
		finalUrl: GNAME_PROVIDER.complaintTypes[payload.report.kind].pageUrl,
		submittedTargets: [payload.target.domain],
	};
}
