import { asRecord } from "../../../values";
import { snippet } from "../kit/text";
import { providerResponseId } from "../report_reference";
import type { BrowserFormField } from "../browser_form";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";
import type { GoDaddySubmissionPayload } from "./payload";

const PORTAL = PROVIDER.portal;

/**
 * Runs inside the Legal Portal page: waits for the page's own reCAPTCHA v3
 * script, then asks it for a token of the form's action. No closures; one
 * serializable argument.
 */
export async function recaptchaTokenProbe(argument: { siteKey: string; action: string; timeoutMs: number }): Promise<string> {
	type Grecaptcha = { ready(callback: () => void): void; execute(siteKey: string, options: { action: string }): Promise<string> };
	const deadline = Date.now() + argument.timeoutMs;
	const scoped = window as unknown as { grecaptcha?: Grecaptcha };
	while (!scoped.grecaptcha?.execute) {
		if (Date.now() >= deadline) throw new Error("grecaptcha did not load");
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const grecaptcha = scoped.grecaptcha;
	return await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("grecaptcha.execute timed out")), Math.max(1_000, deadline - Date.now()));
		grecaptcha.ready(() => {
			grecaptcha.execute(argument.siteKey, { action: argument.action }).then(
				(token) => { clearTimeout(timer); resolve(token); },
				(error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
			);
		});
	});
}

/** The form's hidden inputs: what the page rendered, else the portal's own defaults. */
function portalHiddenFields(rendered: readonly BrowserFormField[]): BrowserFormField[] {
	return PORTAL.hiddenFields.map(([name, fallback]): BrowserFormField => {
		const value = rendered.find(([field]) => field === name)?.[1];
		return [name, typeof value === "string" ? value : fallback];
	});
}

/** The page's rendered `type`, when it renders one: the form must still be the phishing form. */
export function portalRenderedType(rendered: readonly BrowserFormField[]): string | undefined {
	const value = rendered.find(([field]) => field === "type")?.[1];
	return typeof value === "string" && value ? value : undefined;
}

/** The submit request's parts, as the page's own script builds its FormData. */
export function portalFields(payload: GoDaddySubmissionPayload, state: { rendered: readonly BrowserFormField[]; token: string }): BrowserFormField[] {
	return [
		["type", payload.report.type],
		["contact_email", PROVIDER.reporter.email],
		["source", JSON.stringify(payload.report.urls)],
		["target", payload.report.brand],
		["useragent", ""],
		["proxy", PORTAL.defaultCountry],
		["info", payload.report.info],
		["confirmed", "true"],
		...portalHiddenFields(state.rendered).filter(([name]) => name !== "type"),
		["captcha_code", state.token],
	];
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).filter((entry) => entry.length > 0) : [];
}

/** A case id in one entry of the answer's `success` list or in the answer itself; strings count only when they look like GoDaddy's. */
function caseIdIn(entry: unknown): string | undefined {
	if (typeof entry === "string") return new RegExp(`\\b${PORTAL.casePattern}\\b`).exec(entry)?.[0];
	return providerResponseId(entry);
}

export type GoDaddyPortalAccepted = { caseId?: string; text: string };

/**
 * Read the portal's answer to the one submit request: `{success: [...], fail:
 * [...]}`, or `{error, success: [], fail: []}` for a request it refused.
 * Only an answer that proves nothing was filed is a refusal; a captcha
 * verdict goes to a person; everything unrecognized is ambiguous (plain Error).
 */
export function interpretPortalAnswer(answer: { status: number; text: string; json: unknown }): GoDaddyPortalAccepted {
	const json = asRecord(answer.json);
	const success = Array.isArray(json?.success) ? json.success : undefined;
	const fail = strings(json?.fail);
	const error = typeof json?.error === "string" ? snippet(json.error) : undefined;
	if (answer.status >= 200 && answer.status < 300 && success && Array.isArray(json?.fail)) {
		if (success.length > 0) {
			const caseId = success.map(caseIdIn).find((id) => id !== undefined) ?? caseIdIn(json);
			return { ...(caseId ? { caseId } : {}), text: `GoDaddy's Legal Portal accepted the report${fail.length ? ` (it refused: ${fail.join("; ").slice(0, 300)})` : ""}` };
		}
		if (fail.length > 0) throw new ProviderSubmissionRejectedError(`GoDaddy's Legal Portal refused the report: ${fail.join("; ").slice(0, 300)}`);
	}
	if ((answer.status === 400 || answer.status === 422) && error && success?.length === 0 && Array.isArray(json?.fail) && fail.length === 0) {
		if (/captcha|recaptcha|verif/i.test(error)) throw new ProviderSubmissionNeedsHumanError(`GoDaddy's Legal Portal did not accept the reCAPTCHA token: ${error}`);
		throw new ProviderSubmissionRejectedError(`GoDaddy's Legal Portal refused the report: ${error}`);
	}
	throw new Error(`GoDaddy's Legal Portal answered the report with HTTP ${answer.status}: ${snippet(answer.text)}`);
}

export type PortalCaseStatus = { state: string; final: boolean } | undefined;

export type PortalFetch = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "text">>;

/** The public case lookup: undefined when GoDaddy has no such claim; a 429 or anything unexpected throws. */
export async function fetchPortalCaseStatus(caseId: string, dependencies: { fetch?: PortalFetch; signal?: AbortSignal } = {}): Promise<PortalCaseStatus> {
	const signal = AbortSignal.any([AbortSignal.timeout(PORTAL.timeoutMs), ...(dependencies.signal ? [dependencies.signal] : [])]);
	const answer = await (dependencies.fetch ?? ((url, init) => fetch(url, init)))(PORTAL.caseStatusUrl, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json", [PORTAL.requestHeader.name]: PORTAL.requestHeader.value },
		body: JSON.stringify({ caseId }),
		signal,
	});
	const text = await answer.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	const record = asRecord(json);
	if (answer.status === 200 && typeof record?.status === "string" && record.status.trim()) {
		const state = record.status.trim().toLowerCase();
		return { state, final: state === "closed" };
	}
	if (answer.status === 404 || (answer.status === 400 && typeof record?.error === "string" && /invalid case id/i.test(record.error))) return undefined;
	throw new Error(`GoDaddy's case lookup answered ${caseId} with HTTP ${answer.status}: ${snippet(text)}`);
}
