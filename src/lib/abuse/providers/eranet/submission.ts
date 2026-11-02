import { getBrowser } from "../../../browser";
import { abuseEmailCaseUrl } from "../../mail/draft";
import { AbuseRepository } from "../../repository";
import { recordValue, routeContext } from "../../worker/shared";
import { providerDefinitionMatchesPin } from "../definition";
import { providerEvidenceImageArtifactMatches } from "../evidence_image";
import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreflight,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { readEranetCodeFromMailbox, type EranetCodeReader } from "./code_mail";
import { ERANET_PROVIDER } from "./definition";
import {
	buildEranetSubmissionPayload,
	ERANET_EVIDENCE_CONTRACT,
	selectEranetEvidenceArtifact,
	storedEranetSubmissionPayload,
	type EranetSubmissionPayload,
} from "./payload";

/** A file sent through the form's upload endpoint. */
export type EranetUpload = { type: string; filename: string; mimeType: string; base64: string };

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

export type EranetDependencies = {
	openSession?: () => Promise<EranetSession>;
	readCode?: EranetCodeReader;
	loadRouteContext?: typeof routeContext;
	getArtifact?: typeof AbuseRepository.getArtifact;
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
				let parsed: EranetResponse | undefined;
				try {
					parsed = recordValue(JSON.parse(result.text)) as EranetResponse | undefined;
				} catch {
					parsed = undefined;
				}
				if (result.status < 200 || result.status >= 300 || !parsed) throw new Error(`Eranet ${path} failed with HTTP ${result.status}: ${result.text.slice(0, 300)}`);
				return parsed;
			},
			close: () => browser.close().catch(() => undefined),
		};
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}

function errorOf(body: EranetResponse): string | undefined {
	const error = body.error ?? body.Error;
	return typeof error === "string" && error ? error : undefined;
}

async function routeFor(context: ProviderSubmissionContext, dependencies: EranetDependencies) {
	const loaded = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (loaded.route.routeType !== "provider_submission" || loaded.route.providerRegistryKey !== ERANET_PROVIDER.key || loaded.target.targetType !== "domain") {
		throw new Error("Eranet reporting requires a domain target on its own route.");
	}
	return loaded;
}

/** Build the pinned draft before the marker; nothing is sent to Eranet here. */
export async function prepareEranetSubmission(context: ProviderSubmissionContext, dependencies: EranetDependencies = {}): Promise<ProviderSubmissionPreparation> {
	const { route, report, target, evidenceArtifacts } = await routeFor(context, dependencies);
	if (!providerDefinitionMatchesPin(ERANET_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "eranet_provider_definition_pin_mismatch" };
	}
	const observedUrl = target.observedUrls[0];
	if (!observedUrl) return { outcome: "insufficient_evidence", reason: "eranet_requires_an_observed_url" };
	const website = report.legalBrandUrl ?? abuseEmailCaseUrl(report.submissionId);
	if (!website) return { outcome: "insufficient_evidence", reason: "eranet_requires_a_reference_website" };
	const evidence = selectEranetEvidenceArtifact(evidenceArtifacts);
	if (!evidence) return { outcome: "insufficient_evidence", reason: "eranet_requires_a_screenshot" };
	const payload = buildEranetSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl,
		description: report.description,
		allegationCategory: report.allegationCategory,
		website,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		evidence,
	});
	return payload ? { outcome: "ready", payload } : { outcome: "insufficient_evidence", reason: "eranet_report_payload_invalid" };
}

/**
 * Before the marker: upload the screenshot and obtain the mailed code. An
 * uploaded file and a sent code file no complaint, so every failure here is
 * a safe retry.
 */
export async function prepareEranetExternalSubmission(context: ProviderSubmissionContext, dependencies: EranetDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const payload = storedEranetSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Eranet submission payload is malformed.");
	const { report } = await routeFor(context, dependencies);
	let artifactBlob: Buffer | undefined;
	if (payload.evidence) {
		const artifact = await (dependencies.getArtifact ?? AbuseRepository.getArtifact)(report.id, BigInt(payload.evidence.artifactId));
		if (!artifact || !providerEvidenceImageArtifactMatches(payload.evidence, artifact, ERANET_EVIDENCE_CONTRACT)) {
			throw new Error("The persisted Eranet evidence artifact no longer matches its immutable reference.");
		}
		artifactBlob = Buffer.from(artifact.blob);
	}
	const session = await (dependencies.openSession ?? openEranetBrowserSession)();
	try {
		const screenshots: string[] = [];
		if (payload.evidence && artifactBlob) {
			const uploaded = await session.call("UploadFile", { upload: { type: ERANET_PROVIDER.evidence.uploadType, filename: payload.evidence.filename, mimeType: payload.evidence.mimeType, base64: artifactBlob.toString("base64") } });
			const filename = uploaded.Data?.filename;
			if (errorOf(uploaded) || typeof filename !== "string" || !filename) throw new Error(`Eranet screenshot upload failed: ${errorOf(uploaded) ?? "no file name returned"}`);
			screenshots.push(filename);
		}
		const requestedAt = (dependencies.now ?? (() => new Date()))();
		// The form's Aliyun slider token is optional server-side; the mailed code is the gate.
		const sent = await session.call("GetEmailCode", { json: { Email: ERANET_PROVIDER.reporter.email, AliyunCaptchaVerifyParam: "" } });
		if (errorOf(sent)) throw new Error(`Eranet did not send its verification code: ${errorOf(sent)}`);
		const code = await (dependencies.readCode ?? readEranetCodeFromMailbox)(requestedAt, context.signal);
		const state: EranetPreflightState = { session, code, screenshots };
		return { state, dispose: () => session.close() };
	} catch (error) {
		await session.close();
		throw error;
	}
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
		Phone: ERANET_PROVIDER.reporter.phone,
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
	const payload = storedEranetSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Eranet submission payload is malformed.");
	const state = preflight?.state as EranetPreflightState | undefined;
	if (!state?.session || typeof state.code !== "string" || !/^\d{6}$/.test(state.code) || !Array.isArray(state.screenshots)) {
		throw new Error("Eranet submission requires a prepared verification code and its browser session.");
	}
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
