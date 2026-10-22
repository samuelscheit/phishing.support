import { recordValue } from "../../worker/shared";
import type { ProviderSubmissionSuccess } from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";

import { CLOUDFLARE_PROVIDER } from "./definition";
import type { CloudflareReportPayload } from "./report";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 100_000;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;

export type CloudflareApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Operator-supplied credentials; never persisted with the provider run. */
export type CloudflareApiConfig = {
	accountId: string;
	token: string;
};

/**
 * Cloudflare's abuse-reports API needs an account-scoped token with
 * `Trust and Safety Write` on an account holding the abuse-reports entitlement.
 */
export function cloudflareApiConfig(environment: Readonly<Record<string, string | undefined>> = process.env): CloudflareApiConfig {
	const accountId = environment.ABUSE_CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
	const token = environment.ABUSE_CLOUDFLARE_API_TOKEN?.trim() ?? "";
	if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("ABUSE_CLOUDFLARE_ACCOUNT_ID must be a 32-character Cloudflare account ID.");
	if (!token) throw new Error("ABUSE_CLOUDFLARE_API_TOKEN must be an API token with the Trust and Safety Write permission.");
	return { accountId: accountId.toLowerCase(), token };
}

export function cloudflareReportsUrl(accountId: string): string {
	return `${CLOUDFLARE_PROVIDER.apiBaseUrl}/accounts/${accountId}/abuse-reports/${CLOUDFLARE_PROVIDER.reportType}`;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function apiErrorMessages(json: Record<string, unknown> | undefined): string {
	const errors = Array.isArray(json?.errors) ? json.errors : [];
	return errors
		.map((error) => stringField(recordValue(error)?.message) ?? stringField(error))
		.filter((message): message is string => Boolean(message))
		.join("; ");
}

/** Build the exact JSON body of `POST /accounts/{id}/abuse-reports/abuse_phishing`. */
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

/**
 * Interpret the API response after the irreversible request. Client errors
 * (including a missing entitlement) never reached the abuse handler and are
 * safe terminal rejections; anything unconfirmed stays ambiguous.
 */
export function parseCloudflareApiResponse(
	status: number,
	rawBody: string,
	context: { accountId: string; target: string },
): ProviderSubmissionSuccess {
	const body = rawBody.slice(0, MAX_RESPONSE_CHARS);
	let json: Record<string, unknown> | undefined;
	try {
		json = recordValue(JSON.parse(body));
	} catch {
		json = undefined;
	}

	if (status === 401 || status === 403 || status === 405) {
		throw new ProviderSubmissionRejectedError(
			`Cloudflare refused the abuse-report API call (HTTP ${status}); the API token needs Trust and Safety Write on an account with the abuse-reports entitlement.${apiErrorMessages(json) ? ` ${apiErrorMessages(json)}` : ""}`,
		);
	}
	if (status >= 400 && status < 500) {
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected with HTTP ${status}: ${apiErrorMessages(json) || body.slice(0, 500)}`);
	}
	if (status < 200 || status >= 300) {
		throw new Error(`Cloudflare abuse report submission failed with HTTP ${status}: ${body.slice(0, 500)}`);
	}
	if (!json) throw new Error("Cloudflare abuse report returned a successful HTTP status without a valid JSON confirmation.");
	if (json.success === false || (Array.isArray(json.errors) && json.errors.length > 0) || json.result === "failure") {
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected: ${apiErrorMessages(json) || body.slice(0, 1_000)}`);
	}
	if (json.result !== "success") {
		throw new Error("Cloudflare abuse report did not include an explicit success confirmation.");
	}

	return {
		confirmationId: stringField(json.abuse_rand),
		confirmationText: "Cloudflare accepted the phishing abuse report.",
		finalUrl: `${CLOUDFLARE_PROVIDER.dashboardUrl}/${context.accountId}/abuse-reports/submitted`,
		submittedTargets: [context.target],
	};
}

/** File one report. Never retried: the request is not idempotent. */
export async function submitCloudflareAbuseReport(params: {
	config: CloudflareApiConfig;
	report: CloudflareReportPayload;
	target: string;
	signal?: AbortSignal;
	fetch?: CloudflareApiFetch;
}): Promise<ProviderSubmissionSuccess> {
	const request = params.fetch ?? globalThis.fetch;
	const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await request(cloudflareReportsUrl(params.config.accountId), {
		method: "POST",
		redirect: "error",
		signal: params.signal ? AbortSignal.any([params.signal, deadline]) : deadline,
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			authorization: `Bearer ${params.config.token}`,
		},
		body: JSON.stringify(buildCloudflareApiBody(params.report)),
	});
	return parseCloudflareApiResponse(response.status, await response.text(), {
		accountId: params.config.accountId,
		target: params.target,
	});
}
