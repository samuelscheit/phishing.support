import { abuseEmailCaseUrl } from "../../mail/draft";
import { userAgent } from "../../../network/service_identity";
import { asRecord, parseJsonRecord } from "../../../util/values";
import type { ProviderFormFacts } from "../../portal/form_facts";
import { deriveProviderFormFacts } from "../../portal/form_facts";
import { captchaTokenFromPage } from "../kit/captcha";
import { createDraft, type RouteDeps, type VerifiedOf } from "../kit/draft";
import { evidenceReferenceOf, evidenceFileOf, type EvidenceDependencies } from "../kit/evidence";
import { snippet } from "../../../util/text";
import { providerEvidenceImageBytesMatch } from "../kit/evidence";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { NAMESILO_PROVIDER } from "./definition";
import {
	buildNameSiloSubmissionPayload,
	NAMESILO_EVIDENCE_CONTRACT,
	storedNameSiloSubmissionPayload,
	type NameSiloSubmissionPayload,
} from "./payload";
import { type FetchLike } from "../../../http/fetch";

type NameSiloSession = {
	csrfToken: string;
	cookieHeader: string;
	/** When NameSilo stops honouring the CSRF token, in Unix seconds. */
	expiresAt: number;
};

/** A session that would expire this soon is not used: the filing request still has the marker and its own round trip ahead. */
const SESSION_MARGIN_MS = 30_000;

/** What the one filing request needs, kept in memory from before the marker: the verified draft with its screenshot's bytes, the session and the solved captcha. */
type NameSiloPreflightState = NameSiloSession & {
	captchaToken: string;
	payload: NameSiloSubmissionPayload;
	evidenceBytes: Buffer;
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

type NameSiloPreparationDependencies = RouteDeps & {
	deriveFacts?: NameSiloFactsExtractor;
};

export type NameSiloPreflightDependencies = {
	fetch?: FetchLike;
	/** The form's reCAPTCHA token; defaults to the form's own page in a Fabric browser. */
	captchaSolver?: (signal?: AbortSignal) => Promise<string>;
	now?: () => number;
};

export type NameSiloSubmissionDependencies = RouteDeps & {
	fetch?: FetchLike;
	now?: () => number;
	getArtifact?: EvidenceDependencies["getArtifact"];
};

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
	if (!response.ok) throw new Error(`NameSilo CSRF session failed with HTTP ${response.status}: ${snippet(body, 500)}`);
	const json = parseJsonRecord(body);
	const data = json && asRecord(json.data);
	const csrfToken = data?.xsrfToken;
	const expirationTime = data?.expirationTime;
	if (json?.result !== "success"
		|| typeof csrfToken !== "string" || csrfToken.length === 0 || csrfToken.length > 2_048 || /[\r\n\0]/.test(csrfToken)
		|| typeof expirationTime !== "number" || !Number.isSafeInteger(expirationTime) || expirationTime <= Math.floor(now() / 1_000)) {
		throw new Error("NameSilo CSRF session returned malformed or expired token data.");
	}
	const cookies = cookieHeader(response.headers);
	if (!cookies) throw new Error("NameSilo CSRF session did not return the required cookies.");
	return { csrfToken, cookieHeader: cookies, expiresAt: expirationTime };
}

async function fetchNameSiloSession(
	fetcher: FetchLike,
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

/** The preflight's state, when it is whole and its CSRF session still has `SESSION_MARGIN_MS` to live. */
function storedPreflightState(preflight: ProviderSubmissionPreflight, now: () => number): NameSiloPreflightState | undefined {
	const state = preflight && asRecord(preflight.state);
	if (!state
		|| typeof state.expiresAt !== "number" || state.expiresAt * 1_000 - now() < SESSION_MARGIN_MS
		|| typeof state.csrfToken !== "string" || state.csrfToken.length === 0 || state.csrfToken.length > 2_048 || /[\r\n\0]/.test(state.csrfToken)
		|| typeof state.cookieHeader !== "string" || state.cookieHeader.length === 0 || state.cookieHeader.length > 8_192 || /[\r\n\0]/.test(state.cookieHeader)
		|| typeof state.captchaToken !== "string" || state.captchaToken.length === 0 || state.captchaToken.length > 32_768 || /[\r\n\0]/.test(state.captchaToken)
		|| !asRecord(state.payload) || !Buffer.isBuffer(state.evidenceBytes)) {
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
	response: Pick<Response, "ok" | "status" | "text"> & { headers?: Pick<Headers, "get"> },
): Promise<NameSiloResult> {
	const body = await response.text();
	// Cloudflare's firewall in front of NameSilo answered the request itself: it
	// never reached NameSilo, so nothing was filed (a shell chain piped into an
	// interpreter plus an upload trips its rule, production case 375628583143477248).
	if (response.status === 403 && response.headers?.get("cf-mitigated") === "challenge") {
		throw new ProviderSubmissionRejectedError("NameSilo's Cloudflare firewall blocked the report before it reached NameSilo (cf-mitigated: challenge); nothing was filed.");
	}
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
			throw new ProviderSubmissionRejectedError(`NameSilo phishing report rejected: ${snippet(parsed.message ?? "", 500) || "The provider rejected the report."}`);
		}
		throw new Error(`NameSilo phishing report submission failed with HTTP ${response.status}: ${snippet(body, 500)}`);
	}
	if (!parsed) throw new Error("NameSilo phishing report submission returned malformed JSON.");
	if (parsed.result === "error") {
		throw new ProviderSubmissionRejectedError(`NameSilo phishing report rejected: ${snippet(parsed.message ?? "", 500) || "The provider rejected the report."}`);
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

/**
 * The form's required "real website" field. A phishing report names the
 * impersonated brand's site. A malware site impersonates nothing (its app may
 * be invented), so the field carries the case page that holds the evidence;
 * NameSilo's form is its only abuse channel (abuse@ answers with its link).
 */
async function nameSiloRealWebsite(
	report: { allegationCategory: string; description: string; legalBrandUrl: string | null; submissionId: bigint | null },
	target: string,
	dependencies: NameSiloPreparationDependencies,
): Promise<string | undefined> {
	if (report.allegationCategory === "malware") return report.legalBrandUrl ?? abuseEmailCaseUrl(report.submissionId);
	const facts = await (dependencies.deriveFacts ?? defaultNameSiloFacts)({
		target,
		analysis: report.description,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
	});
	return facts.brandOfficialWebsite;
}

export const nameSiloDraft = createDraft({
	definition: NAMESILO_PROVIDER,
	reasonPrefix: "namesilo",
	targetTypes: ["domain"],
	targetReason: "namesilo_requires_a_domain_target",
	read: storedNameSiloSubmissionPayload,
	// What the stored draft holds (its URL, its brand site, its screenshot) is not reselected.
	input: async ({ report, target, evidenceArtifacts }, stored: NameSiloSubmissionPayload | undefined, dependencies: NameSiloPreparationDependencies) => {
		const observedUrl = stored?.target.observedUrl ?? target.observedUrls[0];
		const evidence = evidenceReferenceOf(NAMESILO_EVIDENCE_CONTRACT, evidenceArtifacts, stored);
		// Nothing is derived until the draft has its URL and screenshot.
		const realWebsite = stored ? stored.report.realWebsite : observedUrl && evidence ? await nameSiloRealWebsite(report, target.normalizedTarget, dependencies) : undefined;
		return { target: target.normalizedTarget, observedUrl: observedUrl ?? "", description: report.description, allegationCategory: report.allegationCategory, realWebsite: realWebsite ?? "", evidence };
	},
	admit: ({ target }, input) => !input.observedUrl ? "namesilo_requires_an_observed_url"
		: !input.evidence ? "namesilo_requires_a_valid_supported_evidence_image"
		: !input.realWebsite ? "namesilo_requires_a_verified_brand_website"
		: undefined,
	build: buildNameSiloSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/**
 * Before the marker: the verified draft and its screenshot, the reCAPTCHA
 * token (the solver may take minutes on it), and then, last, the CSRF
 * session, so that neither has aged by the time the filing request follows
 * the marker: the token lives about two minutes, and a session that would
 * expire within `SESSION_MARGIN_MS` is refused here, where a retry is safe.
 */
export async function prepareNameSiloExternalSubmission(
	context: ProviderSubmissionContext,
	{ payload, data }: VerifiedOf<typeof nameSiloDraft>,
	dependencies: NameSiloPreflightDependencies & NameSiloSubmissionDependencies = {},
): Promise<ProviderSubmissionPreflight> {
	const { bytes } = await evidenceFileOf(NAMESILO_EVIDENCE_CONTRACT, "NameSilo", payload.evidence, data, dependencies);
	const now = dependencies.now ?? Date.now;
	const captchaToken = await (dependencies.captchaSolver ?? solveNameSiloCaptcha)(context.signal);
	const session = await fetchNameSiloSession(dependencies.fetch ?? fetch, context.signal, now);
	const state: NameSiloPreflightState = { ...session, captchaToken, payload, evidenceBytes: bytes };
	if (!storedPreflightState({ state }, now)) throw new Error("NameSilo preflight returned invalid ephemeral state or a CSRF session about to expire.");
	return { state };
}

/** The reCAPTCHA v2 token of NameSilo's public form, passed by the solver of a Fabric browser on that page. */
const solveNameSiloCaptcha = (signal?: AbortSignal) => captchaTokenFromPage({
	provider: NAMESILO_PROVIDER.displayName,
	operation: "namesilo-report",
	url: NAMESILO_PROVIDER.reportPageUrl,
	formSelector: NAMESILO_PROVIDER.captcha.formSelector,
	kind: NAMESILO_PROVIDER.captcha.kind,
}, signal);

/** The one provider POST, from the preflight's verified draft and session. */
export async function submitNameSiloSubmission(
	context: ProviderSubmissionContext,
	preflight: ProviderSubmissionPreflight,
	dependencies: Pick<NameSiloSubmissionDependencies, "fetch" | "now"> = {},
): Promise<ProviderSubmissionSuccess> {
	const ephemeral = storedPreflightState(preflight, dependencies.now ?? Date.now);
	// Nothing has been sent: a person (or the next run) can take it from here.
	if (!ephemeral) throw new ProviderSubmissionNeedsHumanError("NameSilo submission requires prepared CSRF and CAPTCHA state with a CSRF session that has not expired; nothing was sent.");
	const { payload } = ephemeral;
	const form = buildNameSiloHttpPayload({ payload, evidenceBytes: ephemeral.evidenceBytes, captchaToken: ephemeral.captchaToken });
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
