import { userAgent } from "../../../constants";
import { AbuseRepository } from "../../repository";
import type { ProviderFormFacts } from "../../skyvern/form_facts";
import { deriveProviderFormFacts } from "../../skyvern/form_facts";
import { recordValue, routeContext } from "../../worker/shared";
import { providerDefinitionMatchesPin } from "../definition";
import {
	providerEvidenceImageArtifactMatches,
	providerEvidenceImageBytesMatch,
} from "../evidence_image";
import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreflight,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { getNameSiloCaptchaCredentials, solveNameSiloCaptcha } from "./captcha";
import { NAMESILO_PROVIDER } from "./definition";
import {
	buildNameSiloSubmissionPayload,
	NAMESILO_EVIDENCE_CONTRACT,
	selectNameSiloEvidenceArtifact,
	storedNameSiloSubmissionPayload,
	type NameSiloSubmissionPayload,
} from "./payload";

type NameSiloFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type NameSiloSession = {
	csrfToken: string;
	cookieHeader: string;
};

type NameSiloPreflightState = NameSiloSession & {
	captchaToken: string;
};

type NameSiloResult = {
	result: "success" | "error";
	message?: string | null;
	code?: number | string;
};

type NameSiloFactsExtractor = (input: {
	target: string;
	analysis: string;
	legalBrandUrl?: string;
}) => Promise<ProviderFormFacts>;

export type NameSiloPreparationDependencies = {
	loadRouteContext?: typeof routeContext;
	deriveFacts?: NameSiloFactsExtractor;
};

export type NameSiloPreflightDependencies = {
	fetch?: NameSiloFetch;
	captchaSolver?: (signal?: AbortSignal) => Promise<string>;
	now?: () => number;
};

export type NameSiloSubmissionDependencies = {
	fetch?: NameSiloFetch;
	loadRouteContext?: typeof routeContext;
	getArtifact?: typeof AbuseRepository.getArtifact;
};

function parseJsonRecord(body: string): Record<string, unknown> | undefined {
	try {
		return recordValue(JSON.parse(body));
	} catch {
		return undefined;
	}
}

function cookieHeader(headers: Headers): string | undefined {
	const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	if (typeof getSetCookie !== "function") return undefined;
	const cookies = new Map<string, string>();
	for (const header of getSetCookie.call(headers)) {
		const pair = header.slice(0, header.indexOf(";") === -1 ? undefined : header.indexOf(";")).trim();
		const separator = pair.indexOf("=");
		if (separator <= 0) continue;
		const name = pair.slice(0, separator);
		const value = pair.slice(separator + 1);
		if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) continue;
		cookies.set(name, `${name}=${value}`);
	}
	if (!cookies.has("PHPSESSID") || !cookies.has("_csrf-sec2")) return undefined;
	return [...cookies.values()].join("; ");
}

/** Validate the token response together with the cookies bound to that token. */
export async function parseNameSiloSessionResponse(
	response: Pick<Response, "headers" | "ok" | "status" | "text">,
	now: () => number = Date.now,
): Promise<NameSiloSession> {
	const body = await response.text();
	if (!response.ok) throw new Error(`NameSilo CSRF session failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
	const json = parseJsonRecord(body);
	const data = json && recordValue(json.data);
	const csrfToken = data?.xsrfToken;
	const expirationTime = data?.expirationTime;
	if (json?.result !== "success"
		|| typeof csrfToken !== "string" || csrfToken.length === 0 || csrfToken.length > 2_048 || /[\r\n\0]/.test(csrfToken)
		|| typeof expirationTime !== "number" || !Number.isSafeInteger(expirationTime) || expirationTime <= Math.floor(now() / 1_000)) {
		throw new Error("NameSilo CSRF session returned malformed or expired token data.");
	}
	const cookies = cookieHeader(response.headers);
	if (!cookies) throw new Error("NameSilo CSRF session did not return the required cookies.");
	return { csrfToken, cookieHeader: cookies };
}

async function fetchNameSiloSession(
	fetcher: NameSiloFetch,
	signal: AbortSignal | undefined,
	now: () => number,
): Promise<NameSiloSession> {
	const response = await fetcher(NAMESILO_PROVIDER.tokenUrl, {
		method: "GET",
		redirect: "error",
		headers: {
			accept: "application/json",
			"user-agent": userAgent,
		},
		...(signal ? { signal } : {}),
	});
	return parseNameSiloSessionResponse(response, now);
}

function storedPreflightState(preflight: ProviderSubmissionPreflight | undefined): NameSiloPreflightState | undefined {
	const state = preflight && recordValue(preflight.state);
	if (!state
		|| typeof state.csrfToken !== "string" || state.csrfToken.length === 0 || state.csrfToken.length > 2_048 || /[\r\n\0]/.test(state.csrfToken)
		|| typeof state.cookieHeader !== "string" || state.cookieHeader.length === 0 || state.cookieHeader.length > 8_192 || /[\r\n\0]/.test(state.cookieHeader)
		|| typeof state.captchaToken !== "string" || state.captchaToken.length === 0 || state.captchaToken.length > 32_768 || /[\r\n\0]/.test(state.captchaToken)) {
		return undefined;
	}
	return state as NameSiloPreflightState;
}

/** Build the exact multipart body only after evidence and ephemeral state validate. */
export function buildNameSiloHttpPayload(params: {
	payload: NameSiloSubmissionPayload;
	evidenceBytes: Buffer;
	captchaToken: string;
}): FormData {
	if (!providerEvidenceImageBytesMatch(params.payload.evidence, params.evidenceBytes, NAMESILO_EVIDENCE_CONTRACT)) {
		throw new Error("NameSilo phishing reporting requires an intact supported evidence image.");
	}
	if (!params.captchaToken.trim() || params.captchaToken.length > 32_768 || /[\r\n\0]/.test(params.captchaToken)) {
		throw new Error("NameSilo phishing reporting requires a valid reCAPTCHA token.");
	}
	const bytes = params.evidenceBytes.buffer.slice(
		params.evidenceBytes.byteOffset,
		params.evidenceBytes.byteOffset + params.evidenceBytes.byteLength,
	) as ArrayBuffer;
	const form = new FormData();
	form.set("email", NAMESILO_PROVIDER.reporter.email);
	form.set("realWebsite", params.payload.report.realWebsite);
	form.set("phishingWebsite", params.payload.target.observedUrl);
	form.set("report", params.payload.report.explanation);
	form.set("g-recaptcha-response", params.captchaToken);
	form.set("file", new Blob([bytes], { type: params.payload.evidence.mimeType }), params.payload.evidence.filename);
	return form;
}

/** Distinguish explicit NameSilo rejections from ambiguous transport results. */
export async function parseNameSiloSubmissionResponse(
	response: Pick<Response, "ok" | "status" | "text">,
): Promise<NameSiloResult> {
	const body = await response.text();
	const json = parseJsonRecord(body);
	const result = json?.result;
	const message = json?.message;
	const code = json?.code;
	const parsed = (result === "success" || result === "error")
		&& (message === undefined || message === null || typeof message === "string")
		&& (code === undefined || typeof code === "string" || typeof code === "number")
		? { result, ...(message === undefined ? {} : { message }), ...(code === undefined ? {} : { code }) } as NameSiloResult
		: undefined;
	if (!response.ok) {
		if (parsed?.result === "error") {
			throw new ProviderSubmissionRejectedError(`NameSilo phishing report rejected: ${parsed.message?.trim().slice(0, 500) || "The provider rejected the report."}`);
		}
		throw new Error(`NameSilo phishing report submission failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
	}
	if (!parsed) throw new Error("NameSilo phishing report submission returned malformed JSON.");
	if (parsed.result === "error") {
		throw new ProviderSubmissionRejectedError(`NameSilo phishing report rejected: ${parsed.message?.trim().slice(0, 500) || "The provider rejected the report."}`);
	}
	return parsed;
}

async function defaultNameSiloFacts(input: {
	target: string;
	analysis: string;
	legalBrandUrl?: string;
}): Promise<ProviderFormFacts> {
	// An operator-supplied brand URL is already the authoritative input. Avoid
	// an unnecessary model call when only that required form field is needed.
	return input.legalBrandUrl
		? deriveProviderFormFacts(input, async () => undefined)
		: deriveProviderFormFacts(input);
}

/** Prepare the immutable NameSilo draft and fail closed on missing evidence. */
export async function prepareNameSiloSubmission(
	context: ProviderSubmissionContext,
	dependencies: NameSiloPreparationDependencies = {},
): Promise<ProviderSubmissionPreparation> {
	const loadRouteContext = dependencies.loadRouteContext ?? routeContext;
	const { route, report, target, evidenceArtifacts } = await loadRouteContext(context.routeId);
	if (route.routeType !== "provider_submission" || route.providerRegistryKey !== NAMESILO_PROVIDER.key || target.targetType !== "domain") {
		return { outcome: "insufficient_evidence", reason: "namesilo_requires_a_domain_target" };
	}
	if (!providerDefinitionMatchesPin(NAMESILO_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "namesilo_provider_definition_pin_mismatch" };
	}
	const observedUrl = target.observedUrls[0];
	if (!observedUrl) return { outcome: "insufficient_evidence", reason: "namesilo_requires_an_observed_url" };
	const evidence = selectNameSiloEvidenceArtifact(evidenceArtifacts);
	if (!evidence) return { outcome: "insufficient_evidence", reason: "namesilo_requires_a_valid_supported_evidence_image" };

	getNameSiloCaptchaCredentials();
	const facts = await (dependencies.deriveFacts ?? defaultNameSiloFacts)({
		target: target.normalizedTarget,
		analysis: report.description,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
	});
	if (!facts.brandOfficialWebsite) {
		return { outcome: "insufficient_evidence", reason: "namesilo_requires_a_verified_brand_website" };
	}
	const payload = buildNameSiloSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl,
		description: report.description,
		realWebsite: facts.brandOfficialWebsite,
		evidence,
	});
	if (!payload) return { outcome: "insufficient_evidence", reason: "namesilo_report_payload_invalid" };
	return { outcome: "ready", payload };
}

/** Fetch CSRF state and solve reCAPTCHA before the irreversible marker. */
export async function prepareNameSiloExternalSubmission(
	context: ProviderSubmissionContext,
	dependencies: NameSiloPreflightDependencies = {},
): Promise<ProviderSubmissionPreflight> {
	if (!storedNameSiloSubmissionPayload(context.payload)) {
		throw new Error("The persisted NameSilo submission payload is malformed.");
	}
	const fetcher = dependencies.fetch ?? fetch;
	const [session, captchaToken] = await Promise.all([
		fetchNameSiloSession(fetcher, context.signal, dependencies.now ?? Date.now),
		(dependencies.captchaSolver ?? ((signal) => solveNameSiloCaptcha({ signal })))(context.signal),
	]);
	const state: NameSiloPreflightState = { ...session, captchaToken };
	if (!storedPreflightState({ state })) throw new Error("NameSilo preflight returned invalid ephemeral state.");
	return { state };
}

/** Perform the one provider POST from its pinned draft and preflight session. */
export async function submitNameSiloSubmission(
	context: ProviderSubmissionContext,
	dependencies: NameSiloSubmissionDependencies = {},
	preflight?: ProviderSubmissionPreflight,
): Promise<ProviderSubmissionSuccess> {
	const payload = storedNameSiloSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted NameSilo submission payload is malformed.");
	const ephemeral = storedPreflightState(preflight);
	if (!ephemeral) throw new Error("NameSilo submission requires prepared CSRF and CAPTCHA state.");

	const loadRouteContext = dependencies.loadRouteContext ?? routeContext;
	const { route, report, target } = await loadRouteContext(context.routeId);
	if (route.routeType !== "provider_submission" || route.providerRegistryKey !== NAMESILO_PROVIDER.key
		|| !providerDefinitionMatchesPin(NAMESILO_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)
		|| target.targetType !== "domain" || target.normalizedTarget !== payload.target.normalizedTarget
		|| !target.observedUrls.includes(payload.target.observedUrl)) {
		throw new Error("The persisted NameSilo submission payload no longer matches its route.");
	}
	const rebuilt = buildNameSiloSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl: payload.target.observedUrl,
		description: report.description,
		realWebsite: payload.report.realWebsite,
		evidence: payload.evidence,
	});
	if (!rebuilt || rebuilt.report.explanation !== payload.report.explanation) {
		throw new Error("The persisted NameSilo submission draft no longer matches the report evidence.");
	}

	let artifactId: bigint;
	try {
		artifactId = BigInt(payload.evidence.artifactId);
	} catch {
		throw new Error("The persisted NameSilo evidence artifact ID is invalid.");
	}
	const artifact = await (dependencies.getArtifact ?? AbuseRepository.getArtifact)(report.id, artifactId);
	if (!artifact || !providerEvidenceImageArtifactMatches(payload.evidence, artifact, NAMESILO_EVIDENCE_CONTRACT)) {
		throw new Error("The persisted NameSilo evidence artifact no longer matches its immutable reference.");
	}

	const form = buildNameSiloHttpPayload({ payload, evidenceBytes: artifact.blob, captchaToken: ephemeral.captchaToken });
	const response = await (dependencies.fetch ?? fetch)(NAMESILO_PROVIDER.submissionUrl, {
		method: "POST",
		redirect: "error",
		headers: {
			accept: "application/json",
			cookie: ephemeral.cookieHeader,
			origin: new URL(NAMESILO_PROVIDER.reportPageUrl).origin,
			referer: NAMESILO_PROVIDER.reportPageUrl,
			"user-agent": userAgent,
			"x-csrf-token": ephemeral.csrfToken,
		},
		body: form,
		...(context.signal ? { signal: context.signal } : {}),
	});
	await parseNameSiloSubmissionResponse(response);
	return {
		confirmationText: "NameSilo accepted the phishing report.",
		finalUrl: NAMESILO_PROVIDER.reportPageUrl,
		submittedTargets: [payload.target.normalizedTarget],
	};
}
