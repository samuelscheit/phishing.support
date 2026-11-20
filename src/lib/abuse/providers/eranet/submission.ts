import { getBrowser } from "../../../browser";
import { abuseEmailCaseUrl } from "../../mail/draft";
import { jsonRecord } from "../kit/http";
import { createDraft, type RouteDeps } from "../kit/draft";
import { evidenceReferenceOf, loadEvidenceFile } from "../kit/evidence";
import { snippet } from "../kit/text";
import { preparedState, withPreflight } from "../kit/session";
import { mailedCodeReader, type MailedCodeReader } from "../mailed_code";
import { ProviderSubmissionRejectedError, type ProviderSubmissionContext, type ProviderSubmissionPreflight, type ProviderSubmissionSuccess } from "../submission_contracts";
import { ERANET_PROVIDER } from "./definition";
import {
	buildEranetSubmissionPayload,
	ERANET_EVIDENCE_CONTRACT,
	storedEranetSubmissionPayload,
	type EranetSubmissionPayload,
} from "./payload";

/** A file sent through the form's upload endpoint. */
type EranetUpload = { type: string; filename: string; mimeType: string; base64: string };

/**
 * One visitor session on Eranet's form. The form accepts its mailed code only
 * inside the browser session that requested it: the page sets session cookies
 * (PHPSESSHASH, locale) a bare API client never gets, and the API answers
 * `VerifyCode.NotFound.Code` without them. Calls therefore run from a page
 * on eranet.com, the way the form itself makes them.
 */
export type EranetSession = {
	call(path: string, body: { json: Record<string, unknown> } | { upload: EranetUpload }): Promise<EranetResponse>;
	close(): Promise<void>;
};

export type EranetDependencies = RouteDeps & {
	openSession?: () => Promise<EranetSession>;
	readCode?: MailedCodeReader;
	getArtifact?: Parameters<typeof loadEvidenceFile>[0]["getArtifact"];
	now?: () => Date;
};

type EranetPreflightState = { session: EranetSession; code: string; screenshots: string[] };

/** Eranet's API answers HTTP 200 with `error` set on every failure. */
type EranetResponse = { RequestId?: string; error?: string; Error?: string; Data?: Record<string, unknown> };

/** A Fabric browser page on the form, over the reporting egress; its fetches carry the form's own session. */
export async function openEranetBrowserSession(): Promise<EranetSession> {
	const browser = await getBrowser("reporting");
	try {
		const page = await browser.defaultBrowserContext().newPage();
		await page.goto(ERANET_PROVIDER.reportPageUrl, { waitUntil: "networkidle2", timeout: 60_000 });
		const apiPath = new URL(ERANET_PROVIDER.apiBaseUrl).pathname;
		return {
			call: async (path, body) => {
				const result = await page.evaluate(async (url, request) => {
					let init: RequestInit;
					if ("json" in request) {
						init = { method: "POST", credentials: "include", headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(request.json) };
					} else {
						const bytes = Uint8Array.from(atob(request.upload.base64), (character) => character.charCodeAt(0));
						const form = new FormData();
						form.append("type", request.upload.type);
						form.append("file", new Blob([bytes], { type: request.upload.mimeType }), request.upload.filename);
						init = { method: "POST", credentials: "include", headers: { Accept: "application/json" }, body: form };
					}
					const response = await fetch(url, init);
					return { status: response.status, text: await response.text() };
				}, `${apiPath}/${path}`, body);
				const parsed = jsonRecord(result.text) as EranetResponse | undefined;
				if (result.status < 200 || result.status >= 300 || !parsed) throw new Error(`Eranet ${path} failed with HTTP ${result.status}: ${snippet(result.text)}`);
				return parsed;
			},
			close: () => browser.close().catch(() => undefined),
		};
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}

export function errorOf(body: EranetResponse): string | undefined {
	const error = body.error ?? body.Error;
	return typeof error === "string" && error ? error : undefined;
}

export const eranetDraft = createDraft({
	definition: ERANET_PROVIDER,
	reasonPrefix: "eranet",
	targetTypes: ["domain"],
	targetReason: "eranet_requires_a_domain_target",
	read: storedEranetSubmissionPayload,
	input: ({ report, target, evidenceArtifacts }, stored: EranetSubmissionPayload | undefined) => ({
		target: target.normalizedTarget,
		observedUrl: stored?.target.observedUrl ?? target.observedUrls[0] ?? "",
		description: report.description,
		allegationCategory: report.allegationCategory,
		website: report.legalBrandUrl ?? abuseEmailCaseUrl(report.submissionId) ?? "",
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		evidence: evidenceReferenceOf(ERANET_EVIDENCE_CONTRACT, evidenceArtifacts, stored),
	}),
	admit: (_data, input) => !input.observedUrl ? "eranet_requires_an_observed_url" : !input.website ? "eranet_requires_a_reference_website" : !input.evidence ? "eranet_requires_a_screenshot" : undefined,
	build: buildEranetSubmissionPayload,
	targetOf: (payload) => payload.target.domain,
});

/** Build the pinned draft before the marker; nothing is sent to Eranet here. */
export const prepareEranetSubmission = eranetDraft.prepare;

/**
 * Before the marker: upload the screenshot and obtain the mailed code. An
 * uploaded file and a sent code file no complaint, so every failure here is
 * a safe retry.
 */
export async function prepareEranetExternalSubmission(context: ProviderSubmissionContext, dependencies: EranetDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const { payload, data } = await eranetDraft.verify(context, dependencies);
	const { bytes } = await loadEvidenceFile({ reference: payload.evidence, contract: ERANET_EVIDENCE_CONTRACT, reportId: data.report.id, label: "Eranet", ...(dependencies.getArtifact ? { getArtifact: dependencies.getArtifact } : {}) });
	return withPreflight(() => (dependencies.openSession ?? openEranetBrowserSession)(), async (session) => {
		const files = [{ filename: payload.evidence.filename, mimeType: payload.evidence.mimeType, content: bytes }];
		const { screenshots, code } = await uploadAndRequestCode(session, ERANET_PROVIDER.evidence.uploadType, files, context.signal, dependencies);
		return { session, code, screenshots } satisfies EranetPreflightState;
	});
}

/**
 * What every Eranet form needs before its one filing request: the screenshots
 * uploaded under the form's upload type, and the code Eranet mails to the
 * reporter. Neither files anything, so a failure here is a safe retry.
 */
export async function uploadAndRequestCode(
	session: EranetSession,
	uploadType: string,
	files: ReadonlyArray<{ filename: string; mimeType: string; content: Buffer }>,
	signal: AbortSignal | undefined,
	dependencies: Pick<EranetDependencies, "readCode" | "now">,
): Promise<{ screenshots: string[]; code: string }> {
	const screenshots: string[] = [];
	for (const file of files) {
		const uploaded = await session.call("UploadFile", { upload: { type: uploadType, filename: file.filename, mimeType: file.mimeType, base64: file.content.toString("base64") } });
		const filename = uploaded.Data?.filename;
		if (errorOf(uploaded) || typeof filename !== "string" || !filename) throw new Error(`Eranet screenshot upload failed: ${errorOf(uploaded) ?? "no file name returned"}`);
		screenshots.push(filename);
	}
	const requestedAt = (dependencies.now ?? (() => new Date()))();
	// The form's Aliyun slider token is optional server-side; the mailed code is the gate.
	const sent = await session.call("GetEmailCode", { json: { Email: ERANET_PROVIDER.reporter.email, AliyunCaptchaVerifyParam: "" } });
	if (errorOf(sent)) throw new Error(`Eranet did not send its verification code: ${errorOf(sent)}`);
	const code = await (dependencies.readCode ?? mailedCodeReader(ERANET_PROVIDER.codeMail))(requestedAt, signal);
	return { screenshots, code };
}

function complaintBody(payload: EranetSubmissionPayload, state: EranetPreflightState): Record<string, unknown> {
	return {
		Email: ERANET_PROVIDER.reporter.email,
		Code: state.code,
		DomainNames: [{ Domain: payload.target.domain, Link: payload.target.observedUrl }],
		ComplaintType: "phishing",
		SubTypes: payload.report.subTypes.join(","),
		Description: payload.report.description,
		Screenshot: state.screenshots,
		ContactType: ERANET_PROVIDER.reporter.contactType,
		Name: "",
		Phone: ERANET_PROVIDER.reporter.contact,
		Certificate: "",
		Proof: "",
		Agent: false,
		AgentName: "",
		AgentPhone: "",
		AgentCertificate: "",
		Commission: "",
		Website: payload.report.website,
	};
}

/** The one irreversible call: CreateComplaint with the pinned draft and the preflight code. */
export async function submitEranetSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined): Promise<ProviderSubmissionSuccess> {
	const payload = eranetDraft.stored(context);
	const state = preparedState<EranetPreflightState>(preflight, (candidate) => !!candidate.session && typeof candidate.code === "string" && /^\d{6}$/.test(candidate.code) && Array.isArray(candidate.screenshots), "Eranet submission requires a prepared verification code and its browser session.");
	const created = await state.session.call("CreateComplaint", { json: complaintBody(payload, state) });
	const error = errorOf(created);
	// Eranet names every rejection; a named error filed nothing.
	if (error) throw new ProviderSubmissionRejectedError(`Eranet rejected the report: ${error}`);
	const orderNo = created.Data?.OrderNo;
	return {
		...(typeof orderNo === "string" && orderNo ? { confirmationId: orderNo } : {}),
		confirmationText: `Eranet accepted the report${typeof orderNo === "string" && orderNo ? ` (receipt ${orderNo})` : ""}.`,
		finalUrl: ERANET_PROVIDER.reportPageUrl,
		submittedTargets: [payload.target.domain],
	};
}
