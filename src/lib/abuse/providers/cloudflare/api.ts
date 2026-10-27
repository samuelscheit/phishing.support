import { recordValue } from "../../worker/shared";
import type { ProviderCorrespondence, ProviderCorrespondenceMessage, ProviderSubmissionSuccess } from "../submission_contracts";
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

type CloudflareRequestContext = {
	config: CloudflareApiConfig;
	session: CloudflareSession;
	signal?: AbortSignal;
	fetch?: CloudflareApiFetch;
	getSession?: CloudflareSessionProvider;
};

/**
 * One authenticated dashboard API call. Only an explicit expired-session
 * rejection (code 9300), which cannot have changed anything, permits one fresh
 * login and a single repeat.
 */
async function cloudflareDashboardRequest<T>(
	context: CloudflareRequestContext,
	request: { url: string; method: "GET" | "POST"; body?: unknown },
	parse: (status: number, rawBody: string) => T,
): Promise<T> {
	const fetchImplementation = context.fetch ?? globalThis.fetch;
	const send = async (session: CloudflareSession) => {
		context.signal?.throwIfAborted();
		const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await fetchImplementation(request.url, {
			method: request.method,
			redirect: "error",
			signal: context.signal ? AbortSignal.any([context.signal, deadline]) : deadline,
			headers: {
				accept: "application/json",
				...(request.body === undefined ? {} : { "content-type": "application/json" }),
				"x-atok": session.atok,
				cookie: `vses2=${session.vses2}`,
				"x-cross-site-security": "dash",
				referer: `${CLOUDFLARE_PROVIDER.dashboardUrl}/`,
			},
			...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
		});
		return parse(response.status, await response.text());
	};
	try {
		return await send(context.session);
	} catch (error) {
		if (!(error instanceof CloudflareSessionExpiredError)) throw error;
	}
	let fresh: CloudflareSession;
	try {
		fresh = await (context.getSession ?? getCloudflareSession)(context.config, { signal: context.signal, expiredSession: context.session });
	} catch {
		throw new ProviderSubmissionNeedsHumanError("Cloudflare dashboard reauthentication failed after an expired session; manual login is required.");
	}
	// Later requests in the same operation use the refreshed session.
	context.session = fresh;
	try {
		return await send(fresh);
	} catch (error) {
		if (error instanceof CloudflareSessionExpiredError) {
			throw new ProviderSubmissionNeedsHumanError("Cloudflare rejected the refreshed dashboard session; manual login is required.");
		}
		throw error;
	}
}

/** Single-shot POST of one abuse report. */
export async function submitCloudflareAbuseReport(params: CloudflareRequestContext & {
	report: CloudflareReportPayload;
	target: string;
}): Promise<ProviderSubmissionSuccess> {
	return cloudflareDashboardRequest(
		params,
		{ url: cloudflareReportsUrl(params.config.accountId), method: "POST", body: buildCloudflareApiBody(params.report) },
		(status, rawBody) => parseCloudflareApiResponse(status, rawBody, { accountId: params.config.accountId, target: params.target }),
	);
}

const SUBMITTED_REPORT_ID = /^[a-f0-9]{16}$/;
const MAX_EMAIL_PAGES = 5;

function submittedReportUrl(accountId: string, reportId: string, suffix = ""): string {
	if (!SUBMITTED_REPORT_ID.test(reportId)) throw new Error("Cloudflare report receipt is not a submitted-report ID.");
	return `${CLOUDFLARE_PROVIDER.apiBaseUrl}/accounts/${accountId}/abuse-reports/submitted/${reportId}${suffix}`;
}

/** A successful read of Cloudflare's documented submitted-report API. */
function parseCloudflareRead(status: number, rawBody: string): Record<string, unknown> {
	const json = responseJson(rawBody);
	const errors = Array.isArray(json?.errors) ? json.errors.map(recordValue) : [];
	if (status === 403 && (String(json?.err_code) === "9300" || errors.some((error) => String(error?.code) === "9300"))) throw new CloudflareSessionExpiredError();
	if (status < 200 || status >= 300 || json?.success !== true) {
		const detail = errors.map((error) => stringField(error?.message)).filter(Boolean).join("; ") || rawBody.slice(0, 300);
		throw new Error(`Cloudflare submitted-report read failed with HTTP ${status}: ${detail}`);
	}
	const result = recordValue(json.result);
	if (!result) throw new Error("Cloudflare submitted-report read returned no result.");
	return { ...result, result_info: json.result_info };
}

/**
 * Read one submitted report's review status and every email Cloudflare
 * delivered to us about it. Both are read-only.
 */
export async function fetchCloudflareSubmittedReport(params: CloudflareRequestContext & { reportId: string }): Promise<ProviderCorrespondence> {
	const report = await cloudflareDashboardRequest(params, { url: submittedReportUrl(params.config.accountId, params.reportId), method: "GET" }, parseCloudflareRead);
	const messages: ProviderCorrespondenceMessage[] = [];
	for (let page = 1; page <= MAX_EMAIL_PAGES; page++) {
		const result = await cloudflareDashboardRequest(
			params,
			{ url: submittedReportUrl(params.config.accountId, params.reportId, `/emails?page=${page}&per_page=100`), method: "GET" },
			parseCloudflareRead,
		);
		for (const email of Array.isArray(result.emails) ? result.emails.map(recordValue) : []) {
			const id = stringField(email?.id);
			const sentAt = stringField(email?.sent_at);
			if (!id || !sentAt || Number.isNaN(Date.parse(sentAt))) continue;
			messages.push({
				id,
				subject: stringField(email?.subject) ?? "",
				body: typeof email?.body === "string" ? email.body.slice(0, MAX_RESPONSE_CHARS) : "",
				...(stringField(email?.recipient) ? { recipient: stringField(email?.recipient) } : {}),
				sentAt: new Date(sentAt),
			});
		}
		const totalPages = Number(recordValue(result.result_info)?.total_pages ?? 1);
		if (!Number.isFinite(totalPages) || page >= totalPages) break;
	}
	const state = stringField(report.status);
	const detail = stringField(report.denial_reason);
	return { messages, ...(state ? { status: { state, ...(detail ? { detail } : {}) } } : {}) };
}
