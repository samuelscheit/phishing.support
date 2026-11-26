
import type { ProviderCorrespondence, ProviderCorrespondenceMessage, ProviderSubmissionSuccess } from "../submission_contracts";
import { ProviderSubmissionDuplicateError, ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";

import { CLOUDFLARE_PROVIDER } from "./definition";
import type { CloudflareReportPayload } from "./report";
import { getCloudflareSession, type CloudflareLoginConfig, type CloudflareSession } from "./session";
import { asRecord, parseJsonRecord, text } from "../../../util/values";
import { snippet } from "../../../util/text";
import { unescapeHtml } from "../../../util/html";
import { deadline } from "../../../util/async";
import { fetchAs, type FetchLike } from "../../../http/fetch";
import { browserUserAgent } from "../../../network/service_identity";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 100_000;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;

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
		...(report.reportedUserAgent ? { reported_user_agent: report.reportedUserAgent } : {}),
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

/** Cloudflare's whole answer to a URL it has a recent report for, from this account or another. */
const DUPLICATE_DETAIL = /^You have already submitted this URL recently: (\S+)$/;

/** The URL a 4xx answer's detail says Cloudflare already has a recent report for. */
function duplicateUrl(status: number, detail: string): string | undefined {
	const url = status === 400 ? DUPLICATE_DETAIL.exec(detail)?.[1] : undefined;
	return url && URL.canParse(url) ? url : undefined;
}

function cloudflareDuplicate(accountId: string, target: string, url: string): ProviderSubmissionDuplicateError {
	return new ProviderSubmissionDuplicateError([url], {
		confirmationText: `Cloudflare already had a recent report for ${url}.`,
		finalUrl: `${CLOUDFLARE_PROVIDER.dashboardUrl}/${accountId}/abuse-reports/submitted`,
		submittedTargets: [target],
	});
}

/**
 * The duplicate a run settled `provider_rejected` with before duplicates were
 * recognised, read from its failure reason.
 */
export function cloudflareDuplicateOfRejection(failureReason: string, context: { accountId: string; target: string }): ProviderSubmissionDuplicateError | undefined {
	const match = /^Cloudflare abuse report was rejected with HTTP (\d{3}): ([\s\S]*)$/.exec(failureReason);
	const url = match && duplicateUrl(Number(match[1]), match[2]!);
	return url ? cloudflareDuplicate(context.accountId, context.target, url) : undefined;
}

/**
 * 4xx is a known rejection, except Cloudflare's duplicate answer: the URL is
 * reported. Server errors and missing receipts remain ambiguous.
 */
export function parseCloudflareApiResponse(
	status: number,
	rawBody: string,
	context: { accountId: string; target: string },
): ProviderSubmissionSuccess {
	const body = rawBody.slice(0, MAX_RESPONSE_CHARS);
	const json = parseJsonRecord(body);
	const errors = Array.isArray(json?.errors) ? json.errors.map(asRecord) : [];
	if (status === 403 && (String(json?.err_code) === "9300" || errors.some((error) => String(error?.code) === "9300"))) {
		throw new CloudflareSessionExpiredError();
	}
	const detail = text(json?.msg) ?? (errors.map((error) => text(error?.message)).filter(Boolean).join("; ") || snippet(body, 500));
	if (status >= 400 && status < 500) {
		const duplicate = duplicateUrl(status, detail);
		if (duplicate) throw cloudflareDuplicate(context.accountId, context.target, duplicate);
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected with HTTP ${status}: ${detail}`);
	}
	if (status < 200 || status >= 300) {
		throw new Error(`Cloudflare abuse report submission failed with HTTP ${status}: ${detail}`);
	}
	if (!json) throw new Error("Cloudflare abuse report returned a successful HTTP status without a valid JSON confirmation.");
	if (json.result === "error") {
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected (${String(json.err_code ?? "unknown")}): ${detail}`);
	}
	const confirmationId = text(json.abuse_rand);
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
	fetch?: FetchLike;
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
	// The dashboard's own API with the dashboard's login session, so it goes out as that page's browser.
	const fetchImplementation = fetchAs(browserUserAgent, context.fetch);
	const send = async (session: CloudflareSession) => {
		context.signal?.throwIfAborted();
		const response = await fetchImplementation(request.url, {
			method: request.method,
			redirect: "error",
			signal: deadline(REQUEST_TIMEOUT_MS, context.signal),
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

/** Cloudflare stores a report and can still answer its gateway with 5xx; this many seconds of clock skew are tolerated. */
const RECEIPT_LOOKUP_SKEW_MS = 60_000;

const SUBMITTED_PAGE_SIZE = 50;
/** How many pages of the account's submitted reports one lookup reads at most. */
const MAX_SUBMITTED_PAGES = 10;

/**
 * The account's submitted reports, newest first, page by page: every report
 * the account filed, whatever the domain. The listing takes a `search`
 * parameter but ignores it (checked 2026-11-26: `search=hostsync.pro` and
 * `search=trylevo.app` both returned all 81 reports), so the domain is
 * filtered here. Reading stops at the first report older than `since`, at the
 * last page, or after MAX_SUBMITTED_PAGES; one page held only the account's 50
 * newest reports, so a report with 50 newer ones of other domains was missed.
 */
async function listSubmittedReports(params: CloudflareRequestContext & { since?: Date }): Promise<Array<{ id: string; domain: string; created: number }>> {
	const listed: Array<{ id: string; domain: string; created: number }> = [];
	for (let page = 1; page <= MAX_SUBMITTED_PAGES; page++) {
		const url = `${CLOUDFLARE_PROVIDER.apiBaseUrl}/accounts/${params.config.accountId}/abuse-reports/submitted?page=${page}&per_page=${SUBMITTED_PAGE_SIZE}`;
		const result = await cloudflareDashboardRequest(params, { url, method: "GET" }, parseCloudflareRead);
		const reports = (Array.isArray(result.reports) ? result.reports.map(asRecord) : [])
			.map((report) => ({ id: text(report?.id), domain: text(report?.domain), created: Date.parse(text(report?.cdate) ?? "") }))
			.filter((report): report is { id: string; domain: string; created: number } => !!report.id && SUBMITTED_REPORT_ID.test(report.id) && !!report.domain && Number.isFinite(report.created));
		listed.push(...reports);
		const totalPages = Number(asRecord(result.result_info)?.total_pages);
		const oldest = Math.min(...reports.map((report) => report.created));
		if (reports.length < SUBMITTED_PAGE_SIZE || (Number.isFinite(totalPages) && page >= totalPages)) break;
		if (params.since && oldest < params.since.getTime() - RECEIPT_LOOKUP_SKEW_MS) break;
	}
	return listed;
}

/**
 * The account's submitted reports for a domain, newest first, whose URLs are
 * exactly `urls` (and justification, when given), created since `since` when
 * given. At most `limit` matches are read in detail.
 */
async function matchingSubmittedReports(params: CloudflareRequestContext & {
	target: string;
	urls: string;
	justification?: string;
	since?: Date;
	limit: number;
}): Promise<string[]> {
	const candidates = (await listSubmittedReports(params))
		.filter((report) => report.domain === params.target && (!params.since || report.created >= params.since.getTime() - RECEIPT_LOOKUP_SKEW_MS))
		.sort((a, b) => b.created - a.created);
	const matches: string[] = [];
	for (const { id } of candidates) {
		if (matches.length >= params.limit) break;
		const detail = await cloudflareDashboardRequest(params, { url: submittedReportUrl(params.config.accountId, id), method: "GET" }, parseCloudflareRead);
		const urls = Array.isArray(detail.urls) ? detail.urls.filter((item): item is string => typeof item === "string") : [];
		if (urls.join("\n") === params.urls && (params.justification === undefined || text(detail.justification) === params.justification)) matches.push(id);
	}
	return matches;
}

/**
 * Find the report a POST created when its answer was lost. The account's
 * submitted reports are read newest first, limited to the domain's created
 * since the POST, and a report counts only when its URLs and justification are exactly
 * the ones sent. More than one match stays ambiguous.
 */
export async function findSubmittedCloudflareReport(params: CloudflareRequestContext & {
	report: CloudflareReportPayload;
	target: string;
	sentAt: Date;
}): Promise<string | undefined> {
	const matches = await matchingSubmittedReports({ ...params, urls: params.report.urls, justification: params.report.justification, since: params.sentAt, limit: 2 });
	return matches.length === 1 ? matches[0] : undefined;
}

/** The account's newest earlier report of exactly this URL, whatever its justification and age. */
async function findEarlierCloudflareReport(params: CloudflareRequestContext & { target: string; url: string }): Promise<string | undefined> {
	return (await matchingSubmittedReports({ ...params, urls: params.url, limit: 1 }))[0];
}

/**
 * Single-shot POST of one abuse report. A server error or a lost answer does
 * not prove the report is missing: Cloudflare stored report 397af589383e9ad3
 * and answered HTTP 504. The account's submitted reports decide it before
 * the outcome is left ambiguous.
 */
export async function submitCloudflareAbuseReport(params: CloudflareRequestContext & {
	report: CloudflareReportPayload;
	target: string;
}): Promise<ProviderSubmissionSuccess> {
	const sentAt = new Date();
	try {
		return await cloudflareDashboardRequest(
			params,
			{ url: cloudflareReportsUrl(params.config.accountId), method: "POST", body: buildCloudflareApiBody(params.report) },
			(status, rawBody) => parseCloudflareApiResponse(status, rawBody, { accountId: params.config.accountId, target: params.target }),
		);
	} catch (error) {
		if (error instanceof ProviderSubmissionDuplicateError) {
			const url = error.urls[0]!;
			const earlier = await findEarlierCloudflareReport({ ...params, url }).catch((lookupError: unknown) => {
				console.warn(`Cloudflare submitted-report lookup after a duplicate answer for ${url} failed:`, lookupError);
				return undefined;
			});
			if (!earlier) throw error;
			return {
				...error.receipt,
				confirmationId: earlier,
				confirmationText: `${error.receipt.confirmationText} Its report ${earlier} in the account's submitted reports is this route's receipt.`,
			};
		}
		if (error instanceof ProviderSubmissionRejectedError || error instanceof ProviderSubmissionNeedsHumanError || error instanceof CloudflareSessionExpiredError) throw error;
		const receipt = await findSubmittedCloudflareReport({ ...params, sentAt }).catch((lookupError: unknown) => {
			console.warn(`Cloudflare submitted-report lookup after a failed POST for ${params.target} failed:`, lookupError);
			return undefined;
		});
		if (!receipt) throw error;
		return cloudflareReceiptSuccess(params.config.accountId, params.target, receipt);
	}
}

/** A report found in the account's submitted reports after the answer to its POST was lost. */
export function cloudflareReceiptSuccess(accountId: string, target: string, receipt: string): ProviderSubmissionSuccess {
	return {
		confirmationId: receipt,
		confirmationText: "Cloudflare stored the abuse report; its answer to the request was lost, and the report was found in the account's submitted reports.",
		finalUrl: `${CLOUDFLARE_PROVIDER.dashboardUrl}/${accountId}/abuse-reports/submitted`,
		submittedTargets: [target],
	};
}

const SUBMITTED_REPORT_ID = /^[a-f0-9]{16}$/;
const MAX_EMAIL_PAGES = 5;

function submittedReportUrl(accountId: string, reportId: string, suffix = ""): string {
	if (!SUBMITTED_REPORT_ID.test(reportId)) throw new Error("Cloudflare report receipt is not a submitted-report ID.");
	return `${CLOUDFLARE_PROVIDER.apiBaseUrl}/accounts/${accountId}/abuse-reports/submitted/${reportId}${suffix}`;
}

/** A successful read of Cloudflare's documented submitted-report API. */
function parseCloudflareRead(status: number, rawBody: string): Record<string, unknown> {
	const json = parseJsonRecord(rawBody.slice(0, MAX_RESPONSE_CHARS));
	const errors = Array.isArray(json?.errors) ? json.errors.map(asRecord) : [];
	if (status === 403 && (String(json?.err_code) === "9300" || errors.some((error) => String(error?.code) === "9300"))) throw new CloudflareSessionExpiredError();
	if (status < 200 || status >= 300 || json?.success !== true) {
		const detail = errors.map((error) => text(error?.message)).filter(Boolean).join("; ") || snippet(rawBody);
		throw new Error(`Cloudflare submitted-report read failed with HTTP ${status}: ${detail}`);
	}
	const result = asRecord(json.result);
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
		for (const email of Array.isArray(result.emails) ? result.emails.map(asRecord) : []) {
			const id = text(email?.id);
			const sentAt = text(email?.sent_at);
			if (!id || !sentAt || Number.isNaN(Date.parse(sentAt))) continue;
			messages.push({
				id,
				subject: unescapeHtml(text(email?.subject) ?? ""),
				body: typeof email?.body === "string" ? unescapeHtml(email.body.slice(0, MAX_RESPONSE_CHARS)) : "",
				...(text(email?.recipient) ? { recipient: text(email?.recipient) } : {}),
				sentAt: new Date(sentAt),
			});
		}
		const totalPages = Number(asRecord(result.result_info)?.total_pages ?? 1);
		if (!Number.isFinite(totalPages) || page >= totalPages) break;
	}
	const state = text(report.status);
	const detail = text(report.denial_reason);
	return { messages, ...(state ? { status: { state, ...(detail ? { detail } : {}) } } : {}) };
}
