import { userAgent } from "../../../constants";
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

type EranetFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type EranetDependencies = {
	fetch?: EranetFetch;
	readCode?: EranetCodeReader;
	loadRouteContext?: typeof routeContext;
	getArtifact?: typeof AbuseRepository.getArtifact;
	now?: () => Date;
};

type EranetPreflightState = { code: string; screenshots: string[] };

/** Eranet's API answers HTTP 200 with `error` set on every failure. */
type EranetResponse = { RequestId?: string; error?: string; Error?: string; Data?: Record<string, unknown> };

async function eranetCall(path: string, init: { json?: Record<string, unknown>; form?: FormData }, dependencies: EranetDependencies, signal?: AbortSignal): Promise<EranetResponse> {
	const response = await (dependencies.fetch ?? fetch)(`${ERANET_PROVIDER.apiBaseUrl}/${path}`, {
		method: "POST",
		redirect: "error",
		headers: {
			accept: "application/json",
			origin: new URL(ERANET_PROVIDER.reportPageUrl).origin,
			referer: ERANET_PROVIDER.reportPageUrl,
			"user-agent": userAgent,
			...(init.json ? { "content-type": "application/json" } : {}),
		},
		body: init.json ? JSON.stringify(init.json) : init.form,
		...(signal ? { signal } : {}),
	});
	const text = await response.text();
	let body: EranetResponse | undefined;
	try {
		body = recordValue(JSON.parse(text)) as EranetResponse | undefined;
	} catch {
		body = undefined;
	}
	if (!response.ok || !body) throw new Error(`Eranet ${path} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
	return body;
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
	const screenshots: string[] = [];
	if (payload.evidence) {
		const artifact = await (dependencies.getArtifact ?? AbuseRepository.getArtifact)(report.id, BigInt(payload.evidence.artifactId));
		if (!artifact || !providerEvidenceImageArtifactMatches(payload.evidence, artifact, ERANET_EVIDENCE_CONTRACT)) {
			throw new Error("The persisted Eranet evidence artifact no longer matches its immutable reference.");
		}
		const form = new FormData();
		form.append("type", ERANET_PROVIDER.evidence.uploadType);
		form.append("file", new Blob([new Uint8Array(artifact.blob)], { type: payload.evidence.mimeType }), payload.evidence.filename);
		const uploaded = await eranetCall("UploadFile", { form }, dependencies, context.signal);
		const filename = uploaded.Data?.filename;
		if (errorOf(uploaded) || typeof filename !== "string" || !filename) throw new Error(`Eranet screenshot upload failed: ${errorOf(uploaded) ?? "no file name returned"}`);
		screenshots.push(filename);
	}
	const requestedAt = (dependencies.now ?? (() => new Date()))();
	// The form's Aliyun slider token is optional server-side; the mailed code is the gate.
	const sent = await eranetCall("GetEmailCode", { json: { Email: ERANET_PROVIDER.reporter.email, AliyunCaptchaVerifyParam: "" } }, dependencies, context.signal);
	if (errorOf(sent)) throw new Error(`Eranet did not send its verification code: ${errorOf(sent)}`);
	const code = await (dependencies.readCode ?? readEranetCodeFromMailbox)(requestedAt, context.signal);
	const state: EranetPreflightState = { code, screenshots };
	return { state };
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
export async function submitEranetSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined, dependencies: EranetDependencies = {}): Promise<ProviderSubmissionSuccess> {
	const payload = storedEranetSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Eranet submission payload is malformed.");
	const state = recordValue(preflight?.state) as EranetPreflightState | undefined;
	if (!state || typeof state.code !== "string" || !/^\d{6}$/.test(state.code) || !Array.isArray(state.screenshots)) {
		throw new Error("Eranet submission requires a prepared verification code.");
	}
	const created = await eranetCall("CreateComplaint", { json: complaintBody(payload, state) }, dependencies, context.signal);
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
