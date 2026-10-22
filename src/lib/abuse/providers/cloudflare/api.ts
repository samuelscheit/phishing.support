import { recordValue } from "../../worker/shared";
import type { ProviderSubmissionSuccess } from "../submission_contracts";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";

import { CLOUDFLARE_PROVIDER } from "./definition";
import type { CloudflareReportPayload } from "./report";
import { getCloudflareSession, type CloudflareLoginConfig, type CloudflareSession } from "./session";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 100_000;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;

export type CloudflareApiFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type CloudflareApiConfig = CloudflareLoginConfig;
export type CloudflareSessionProvider = typeof getCloudflareSession;

/** Operator credentials are never persisted with the provider run. */
export function cloudflareApiConfig(environment: Readonly<Record<string, string | undefined>> = process.env): CloudflareApiConfig {
	const accountId = environment.ABUSE_CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
	const email = environment.ABUSE_CLOUDFLARE_LOGIN_EMAIL?.trim() ?? "";
	const password = environment.ABUSE_CLOUDFLARE_LOGIN_PASSWORD ?? "";
	if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("ABUSE_CLOUDFLARE_ACCOUNT_ID must be a 32-character Cloudflare account ID.");
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ABUSE_CLOUDFLARE_LOGIN_EMAIL must be a valid dashboard login email.");
	if (!password.trim()) throw new Error("ABUSE_CLOUDFLARE_LOGIN_PASSWORD is required for the dashboard login.");
	return { accountId: accountId.toLowerCase(), email, password };
}

export function cloudflareReportsUrl(accountId: string): string {
	return `${CLOUDFLARE_PROVIDER.apiBaseUrl}/accounts/${accountId}/abuse-reports/${CLOUDFLARE_PROVIDER.reportType}`;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function responseJson(rawBody: string): Record<string, unknown> | undefined {
	try {
		return recordValue(JSON.parse(rawBody.slice(0, MAX_RESPONSE_CHARS)));
	} catch {
		return undefined;
	}
}

/** Build the exact dashboard abuse_phishing request body. */
export function buildCloudflareApiBody(report: CloudflareReportPayload) {
	return {
		act: CLOUDFLARE_PROVIDER.reportType,
		name: report.name,
		email: report.email,
		email2: report.email,
		company: report.company,
		urls: report.urls,
		justification: report.justification,
		...(report.originalWork ? { original_work: report.originalWork } : {}),
		reported_country: report.reportedCountry,
		host_notification: "send-anon",
		owner_notification: "send-anon",
	} as const;
}

/** Only an explicit dashboard authentication rejection is safe to reauthenticate. */
export class CloudflareSessionExpiredError extends Error {
	constructor() {
		super("Cloudflare dashboard session expired (HTTP 403, code 9300).");
		this.name = "CloudflareSessionExpiredError";
	}
}

/** 4xx is a known rejection; server errors and missing receipts remain ambiguous. */
export function parseCloudflareApiResponse(
	status: number,
	rawBody: string,
	context: { accountId: string; target: string },
): ProviderSubmissionSuccess {
	const body = rawBody.slice(0, MAX_RESPONSE_CHARS);
	const json = responseJson(body);
	const errors = Array.isArray(json?.errors) ? json.errors.map(recordValue) : [];
	if (status === 403 && (String(json?.err_code) === "9300" || errors.some((error) => String(error?.code) === "9300"))) {
		throw new CloudflareSessionExpiredError();
	}
	const detail = stringField(json?.msg) ?? (errors.map((error) => stringField(error?.message)).filter(Boolean).join("; ") || body.slice(0, 500));
	if (status >= 400 && status < 500) {
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected with HTTP ${status}: ${detail}`);
	}
	if (status < 200 || status >= 300) {
		throw new Error(`Cloudflare abuse report submission failed with HTTP ${status}: ${detail}`);
	}
	if (!json) throw new Error("Cloudflare abuse report returned a successful HTTP status without a valid JSON confirmation.");
	if (json.result === "error") {
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected (${String(json.err_code ?? "unknown")}): ${detail}`);
	}
	const confirmationId = stringField(json.abuse_rand);
	if (json.result !== "success" || !confirmationId) {
		throw new Error("Cloudflare abuse report did not include an explicit success confirmation and abuse_rand receipt.");
	}
	return {
		confirmationId,
		confirmationText: "Cloudflare accepted the phishing abuse report.",
		finalUrl: `${CLOUDFLARE_PROVIDER.dashboardUrl}/${context.accountId}/abuse-reports/submitted`,
		submittedTargets: [context.target],
	};
}

/** Single-shot POST. Only code 9300, which cannot have filed a report, permits one fresh login. */
export async function submitCloudflareAbuseReport(params: {
	config: CloudflareApiConfig;
	session: CloudflareSession;
	report: CloudflareReportPayload;
	target: string;
	signal?: AbortSignal;
	fetch?: CloudflareApiFetch;
	getSession?: CloudflareSessionProvider;
}): Promise<ProviderSubmissionSuccess> {
	const request = params.fetch ?? globalThis.fetch;
	const send = async (session: CloudflareSession) => {
		params.signal?.throwIfAborted();
		const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await request(cloudflareReportsUrl(params.config.accountId), {
			method: "POST",
			redirect: "error",
			signal: params.signal ? AbortSignal.any([params.signal, deadline]) : deadline,
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"x-atok": session.atok,
				cookie: `vses2=${session.vses2}`,
				"x-cross-site-security": "dash",
				referer: `${CLOUDFLARE_PROVIDER.dashboardUrl}/`,
			},
			body: JSON.stringify(buildCloudflareApiBody(params.report)),
		});
		return parseCloudflareApiResponse(response.status, await response.text(), { accountId: params.config.accountId, target: params.target });
	};
	try {
		return await send(params.session);
	} catch (error) {
		if (!(error instanceof CloudflareSessionExpiredError)) throw error;
	}
	let fresh: CloudflareSession;
	try {
		fresh = await (params.getSession ?? getCloudflareSession)(params.config, { signal: params.signal, expiredSession: params.session });
	} catch {
		throw new ProviderSubmissionNeedsHumanError("Cloudflare dashboard reauthentication failed after an expired session; manual login is required.");
	}
	try {
		return await send(fresh);
	} catch (error) {
		if (error instanceof CloudflareSessionExpiredError) {
			throw new ProviderSubmissionNeedsHumanError("Cloudflare rejected the refreshed dashboard session; manual login is required.");
		}
		throw error;
	}
}
