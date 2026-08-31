import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreflight,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import { solveDeathByCaptchaToken } from "../../captcha/death_by_captcha";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { getProviderProxy } from "../proxy";
import { recordValue, routeContext } from "../../worker/shared";

import { CLOUDFLARE_PROVIDER } from "./definition";
import { buildCloudflareFormPayload, type CloudflareFormPayload } from "./form";
import { cloudflareServiceIdentity } from "./identity";
import {
	dismissCloudflareConsentBanner,
	isCloudflareManagedChallenge,
	makeCloudflareClearanceCookieUsable,
	resolveCloudflareEdgeChallenge,
	solveCloudflareAbuseTurnstile,
	type CloudflareTurnstileSession,
} from "./turnstile";

const fallbackCloudflareUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

type CloudflareSubmissionPayload = {
	adapter: "cloudflare_abuse_phishing_v1";
	providerNarrativeVersion: 1;
	target: string;
	form: CloudflareFormPayload;
};

type CloudflareResponse = {
	ok(): boolean;
	status(): number;
	text(): Promise<string>;
	headers?(): Record<string, string>;
};

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function firstReportId(value: unknown): string | undefined {
	if (Array.isArray(value)) return value.map(stringField).find(Boolean);
	return stringField(value);
}

function parseStoredPayload(value: Record<string, unknown>): CloudflareSubmissionPayload | undefined {
	if (value.adapter !== "cloudflare_abuse_phishing_v1" || value.providerNarrativeVersion !== 1 || typeof value.target !== "string" || !value.target) return undefined;
	const form = recordValue(value.form);
	if (!form
		|| typeof form.name !== "string"
		|| typeof form.email !== "string"
		|| typeof form.emailConfirmation !== "string"
		|| typeof form.company !== "string"
		|| typeof form.urls !== "string"
		|| typeof form.justification !== "string"
		|| typeof form.originalWork !== "string"
		|| typeof form.reportedCountry !== "string"
		|| form.dsaAttestation !== true
		|| form.dsaCertification !== true) return undefined;
	try {
		new URL(form.urls);
		new URL(form.company);
	} catch {
		return undefined;
	}
	return { adapter: "cloudflare_abuse_phishing_v1", providerNarrativeVersion: 1, target: value.target, form: form as unknown as CloudflareFormPayload };
}

/** Build Cloudflare's immutable submission payload before its browser boundary. */
export async function prepareCloudflareSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const { report, target } = await routeContext(context.routeId);
	if (report.allegationCategory !== "phishing") {
		throw new ProviderSubmissionRejectedError("Cloudflare's phishing form can only receive phishing allegations.");
	}
	if (target.targetType !== "domain") {
		return { outcome: "insufficient_evidence", reason: "cloudflare_phishing_form_requires_domain_target" };
	}
	const observedUrl = target.observedUrls[0];
	if (!observedUrl) return { outcome: "insufficient_evidence", reason: "cloudflare_phishing_form_requires_observed_url" };

	// Validate local configuration before the durable marker. It is deliberately
	// not embedded in the immutable payload because proxy credentials are secret.
	getProviderProxy("Cloudflare abuse reporting");
	const serviceIdentity = cloudflareServiceIdentity(report.requesterCountry);
	const form = buildCloudflareFormPayload({
		serviceIdentity,
		target: target.normalizedTarget,
		observedUrl,
		description: report.description,
		legalBrandUrl: report.legalBrandUrl ?? undefined,
	});
	return {
		outcome: "ready",
		payload: {
			adapter: "cloudflare_abuse_phishing_v1",
			providerNarrativeVersion: 1,
			target: target.normalizedTarget,
			form,
		},
	};
}

/** Interpret an explicit Cloudflare endpoint response after the form click. */
export async function parseCloudflareSubmissionResponse(response: CloudflareResponse, finalUrl: string, target: string): Promise<ProviderSubmissionSuccess> {
	const body = await response.text();
	const headers = response.headers?.() ?? {};
	const challengeResponse = headers["cf-mitigated"]?.toLowerCase() === "challenge"
		|| (response.status() === 403 && /<title>\s*(?:just a moment|sorry, you have been blocked)/i.test(body));
	if (challengeResponse) {
		const ray = headers["cf-ray"] ? ` (Ray ID ${headers["cf-ray"]})` : "";
		throw new ProviderSubmissionRejectedError(`Cloudflare rejected the abuse-form request with a managed security challenge${ray}; no provider confirmation was received.`);
	}
	if (!response.ok()) {
		if (response.status() >= 400 && response.status() < 500) {
			throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected with HTTP ${response.status()}: ${body.slice(0, 500)}`);
		}
		throw new Error(`Cloudflare abuse report submission failed with HTTP ${response.status()}: ${body.slice(0, 500)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Cloudflare abuse report returned a successful HTTP status without a valid JSON confirmation.");
	}
	const json = recordValue(parsed);
	if (!json) throw new Error("Cloudflare abuse report returned an invalid confirmation response.");
	if (json.success === false || (Array.isArray(json.errors) && json.errors.length > 0)) {
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected: ${body.slice(0, 1_000)}`);
	}
	if (json.result === "failure") {
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected: ${body.slice(0, 1_000)}`);
	}
	if (json.success !== true && json.result !== "success") {
		throw new Error("Cloudflare abuse report did not include an explicit success confirmation.");
	}

	return {
		confirmationId: stringField(json.id) ?? stringField(json.report_id) ?? stringField(json.case_id) ?? firstReportId(json.report_ids),
		confirmationText: stringField(json.message) ?? stringField(json.msg) ?? body.slice(0, 2_000),
		finalUrl,
		submittedTargets: [target],
	};
}

type CloudflareApiForm = {
	name: string;
	email: string;
	email2: string;
	title: string;
	company: string;
	tele: string;
	urls: string;
	justification: string;
	original_work: string;
	reported_country: string;
	reported_user_agent: string;
	comments: string;
	host_notification: "send-anon";
	owner_notification: "send-anon";
	dsa_attestation: true;
	act: "abuse_phishing";
	"cf-turnstile-response": string;
};

/** Match the exact request shape sent by Cloudflare's current form client. */
export function buildCloudflareApiForm(
	form: CloudflareFormPayload,
	token: string,
	reportedUserAgent = fallbackCloudflareUserAgent,
): CloudflareApiForm {
	if (!token.trim()) throw new Error("Cloudflare Turnstile token must not be empty.");
	if (!reportedUserAgent.trim()) throw new Error("Cloudflare browser user agent must not be empty.");
	return {
		name: form.name,
		email: form.email,
		email2: form.emailConfirmation,
		title: "",
		company: form.company,
		tele: "",
		urls: form.urls,
		justification: form.justification,
		original_work: form.originalWork,
		reported_country: form.reportedCountry,
		reported_user_agent: reportedUserAgent,
		comments: "",
		host_notification: "send-anon",
		owner_notification: "send-anon",
		dsa_attestation: true,
		act: "abuse_phishing",
		"cf-turnstile-response": token,
	};
}

type CloudflareApiResponse = {
	ok: boolean;
	status: number;
	body: string;
	cfMitigated: string | null;
	cfRay: string | null;
};

export function isCloudflareEdgeChallenge(response: Pick<CloudflareApiResponse, "status" | "cfMitigated" | "body">): boolean {
	return isCloudflareManagedChallenge({
		status: response.status,
		headers: response.cfMitigated ? { "cf-mitigated": response.cfMitigated } : {},
		body: response.body,
	});
}

async function postCloudflareApiOnce(page: CloudflareTurnstileSession["page"], form: CloudflareApiForm, token: string): Promise<CloudflareApiResponse> {
	return page.evaluate(async ({ body, turnstileToken }) => {
		const response = await fetch("/api/v2/form/abuse_phishing", {
			method: "POST",
			credentials: "include",
			signal: AbortSignal.timeout(15_000),
			headers: {
				"Content-Type": "application/json",
				"X-Turnstile-Token": turnstileToken,
			},
			body: JSON.stringify(body),
		});
		return {
			ok: response.ok,
			status: response.status,
			body: (await response.text()).slice(0, 100_000),
			cfMitigated: response.headers.get("cf-mitigated"),
			cfRay: response.headers.get("cf-ray"),
		};
	}, { body: form, turnstileToken: token });
}

async function refreshCloudflareTurnstileToken(session: CloudflareTurnstileSession): Promise<string> {
	return solveDeathByCaptchaToken({
		type: 12,
		parametersField: "turnstile_params",
		parameters: {
			proxy: session.proxy.url,
			proxytype: "HTTP",
			sitekey: session.siteKey,
			pageurl: CLOUDFLARE_PROVIDER.formUrl,
		},
	});
}

/**
 * The API endpoint is protected by a separate managed edge challenge. It is
 * safe to retry exactly once when Cloudflare explicitly identifies the first
 * response as a challenge: that response was generated at the edge and was
 * not forwarded to the abuse-form handler.
 */
async function postCloudflareApi(session: CloudflareTurnstileSession, form: CloudflareApiForm): Promise<CloudflareApiResponse> {
	let token = session.token;
	let response = await postCloudflareApiOnce(session.page, form, token);
	if (!isCloudflareEdgeChallenge(response)) return response;

	try {
		await resolveCloudflareEdgeChallenge(session.page, response.body);
		await dismissCloudflareConsentBanner(session.page).catch(() => undefined);
		await makeCloudflareClearanceCookieUsable(session.context, CLOUDFLARE_PROVIDER.formUrl).catch(() => undefined);
		// Cloudflare may consume the first token while issuing the edge challenge;
		// obtain a fresh token after clearance rather than retrying a stale one.
		token = await refreshCloudflareTurnstileToken(session);
		session.token = token;
	} catch (error) {
		throw new ProviderSubmissionRejectedError(`Cloudflare's managed security challenge could not be automated: ${error instanceof Error ? error.message : String(error)}`);
	}
	// Keep transport errors from the second request ambiguous: unlike the
	// first edge response, they do not prove that Cloudflare never received the
	// complaint and therefore must not be settled as a safe rejection.
	response = await postCloudflareApiOnce(session.page, { ...form, "cf-turnstile-response": token }, token);
	return response;
}

/**
 * Obtain ephemeral browser/Turnstile state before the irreversible provider
 * marker. The token is deliberately kept out of the durable provider run.
 */
export async function prepareCloudflareExternalSubmission(_context: ProviderSubmissionContext): Promise<ProviderSubmissionPreflight> {
	const session = await solveCloudflareAbuseTurnstile();
	return {
		state: session,
		dispose: async () => {
			await session.browser.close();
		},
	};
}

/** Submit one already-persisted Cloudflare form payload with an ephemeral token. */
export async function submitCloudflareSubmission(
	context: ProviderSubmissionContext,
	preflight?: ProviderSubmissionPreflight,
): Promise<ProviderSubmissionSuccess> {
	const payload = parseStoredPayload(context.payload);
	if (!payload) throw new Error("The persisted Cloudflare provider payload is malformed.");
	const session = preflight?.state as CloudflareTurnstileSession | undefined;
	if (!session?.page || !session.token) {
		throw new Error("Cloudflare submission requires a preflight Turnstile session.");
	}
	const response = await postCloudflareApi(session, buildCloudflareApiForm(payload.form, session.token, session.userAgent));
	return parseCloudflareSubmissionResponse({
		ok: () => response.ok,
		status: () => response.status,
		text: async () => response.body,
		headers: () => ({
			...(response.cfMitigated ? { "cf-mitigated": response.cfMitigated } : {}),
			...(response.cfRay ? { "cf-ray": response.cfRay } : {}),
		}),
	}, session.page.url(), payload.target);
}
