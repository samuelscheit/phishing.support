import type { HTTPResponse, Page } from "rebrowser-puppeteer-core";

import { getBrowser, getBrowserPage } from "../../../browser";
import { abuseEmailCaseUrl } from "../../mail/draft";
import { raceAbort, throwIfOperationCanceled } from "../../worker/cancellation";
import { createDraft, type RouteData } from "../kit/draft";
import { solveRecaptchaV2 } from "../kit/captcha";
import { jsonRecord } from "../kit/http";
import { snippet } from "../kit/text";
import { emailOriginOf } from "../email_origin";
import { ProviderSubmissionRejectedError, type ProviderSubmissionContext, type ProviderSubmissionSuccess } from "../submission_contracts";
import { GOOGLE_CLOUD_PROVIDER } from "./definition";
import {
	buildGoogleCloudSubmissionPayload,
	storedGoogleCloudSubmissionPayload,
	type GoogleCloudReportInput,
	type GoogleCloudSubmissionPayload,
} from "./payload";

const CANCELED = "Google Cloud abuse report submission was canceled.";
const FORM_READY_TIMEOUT_MS = 45_000;
const SUBMIT_RESPONSE_TIMEOUT_MS = 60_000;
const CONFIRMATION_TIMEOUT_MS = 20_000;

type GoogleCloudFormSession = { page: Page; close(): Promise<void> };

export type GoogleCloudSubmissionDependencies = {
	/** A page on the direct reporting egress; Google's form challenges Tor exits. */
	openPage?: () => Promise<GoogleCloudFormSession>;
	reportPageUrl?: string;
	timeouts?: Partial<{ formReadyMs: number; submitResponseMs: number; confirmationMs: number }>;
	solveCaptcha?: (signal?: AbortSignal) => Promise<string>;
};

/** Solve the checkbox reCAPTCHA the form falls back to. */
export const solveGoogleCloudCaptcha = (signal?: AbortSignal) => solveRecaptchaV2(GOOGLE_CLOUD_PROVIDER.captcha, GOOGLE_CLOUD_PROVIDER.reportPageUrl, signal);

async function openReportingPage(): Promise<GoogleCloudFormSession> {
	const browser = await getBrowser("reporting");
	try {
		const { page } = await getBrowserPage(await browser.defaultBrowserContext().newPage());
		return { page, close: () => browser.close() };
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}

/** The report's inputs; an IP target that sent a phishing email also carries that email's origin. */
async function reportInput(data: RouteData): Promise<GoogleCloudReportInput & { target: string }> {
	const { report, target, evidenceArtifacts } = data;
	const emailOrigin = target.observedUrls.length === 0 ? await emailOriginOf({ target, evidenceArtifacts }) : undefined;
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	return {
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		allegationCategory: report.allegationCategory,
		capturedAt: report.createdAt,
		...(caseUrl ? { caseUrl } : {}),
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		...(emailOrigin ? { emailOrigin } : {}),
	};
}

export const googleCloudDraft = createDraft({
	definition: GOOGLE_CLOUD_PROVIDER,
	reasonPrefix: "google_cloud",
	targetTypes: ["domain", "ip", "service_account", "campaign"],
	targetReason: "google_cloud_requires_a_web_target",
	read: storedGoogleCloudSubmissionPayload,
	input: reportInput,
	admit: (_data, input) => input.observedUrls.length === 0 && !input.emailOrigin ? "google_cloud_requires_an_observed_url" : undefined,
	build: buildGoogleCloudSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/** Check the route and build the durable draft before any provider call. */
export const prepareGoogleCloudSubmission = (context: ProviderSubmissionContext) => googleCloudDraft.prepare(context);

/**
 * Set a field's value and fire the events the form's own script listens for.
 * Typing is not used: the live form moves focus mid-typing (to its article
 * suggestions), which drops the rest of the text.
 */
async function fill(page: Page, selector: string, value: string): Promise<void> {
	await page.$eval(selector, (element, text) => {
		const field = element as HTMLInputElement | HTMLTextAreaElement;
		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
		field.focus();
		if (setter) setter.call(field, text);
		else field.value = text;
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new Event("change", { bubbles: true }));
		field.blur();
	}, value);
}

async function fillGoogleCloudForm(page: Page, payload: GoogleCloudSubmissionPayload): Promise<void> {
	await fill(page, "#email_prefill_req", GOOGLE_CLOUD_PROVIDER.reporter.email);
	await page.click(`#Google_Cloud_Platform_Service--${payload.report.service}`);
	await fill(page, "#abuse_date", payload.report.abuseDate);
	await fill(page, "#abuse_details", payload.report.abuseDetails);
	const entered = await page.evaluate(() => ({
		email: (document.querySelector("#email_prefill_req") as HTMLInputElement | null)?.value,
		details: (document.querySelector("#abuse_details") as HTMLTextAreaElement | null)?.value,
	}));
	if (entered.email !== GOOGLE_CLOUD_PROVIDER.reporter.email || entered.details !== payload.report.abuseDetails) {
		throw new Error("The Google Cloud abuse form did not accept the report fields as entered.");
	}
}

/** The visible notification under the form after a failed send, if any. */
async function formNotification(page: Page): Promise<string> {
	return page.evaluate(() => [...document.querySelectorAll(".notification-area")]
		.map((element) => (element as HTMLElement).innerText.trim())
		.filter(Boolean)
		.join(" ")).catch(() => "");
}

export type GoogleCloudSubmitAnswer =
	| { outcome: "accepted"; caseId?: string }
	/** No case was created: Google wants the checkbox reCAPTCHA solved first. */
	| { outcome: "captcha_required" };

/**
 * Read the form's own submit response. Only Google's explicit answer decides
 * the outcome: `ACCEPTED`/`SUCCESS`/`RETRIED` created a case, a
 * `REQUIRED_RECAPTCHA` result created none, a 4xx or `PERM_FAILURE` is a
 * rejection, and anything else after the click is ambiguous.
 */
export async function readGoogleCloudSubmitResponse(response: Pick<HTTPResponse, "status" | "text">): Promise<GoogleCloudSubmitAnswer> {
	const body = await response.text().catch(() => "");
	// Google prefixes JSON API responses with an anti-hijacking line.
	const json = jsonRecord(body.replace(/^\)\]\}'[^\n]*\n/, ""));
	const status = response.status();
	if (status >= 400 && status < 500) {
		throw new ProviderSubmissionRejectedError(`Google Cloud abuse form rejected the report with HTTP ${status}: ${snippet(body)}`);
	}
	if (status < 200 || status >= 300 || !json) {
		throw new Error(`Google Cloud abuse form answered HTTP ${status} with an unreadable response: ${snippet(body)}`);
	}
	const results = Array.isArray(json.result) ? json.result.filter((item): item is string => typeof item === "string") : [];
	const [first] = results;
	if (json.error === undefined && first && ["ACCEPTED", "SUCCESS", "RETRIED"].includes(first)) {
		const caseId = typeof json.case_id === "string" && /^[A-Za-z0-9-]{4,64}$/.test(json.case_id) ? json.case_id : undefined;
		return { outcome: "accepted", ...(caseId ? { caseId } : {}) };
	}
	if (results.length > 0 && results.every((item) => item.split(":")[0] === "REQUIRED_RECAPTCHA")) return { outcome: "captcha_required" };
	if (first?.startsWith("PERM_FAILURE") || (Array.isArray(json.submit_error) && json.submit_error.length > 0)) {
		throw new ProviderSubmissionRejectedError(`Google Cloud abuse form refused the report: ${snippet(body)}`);
	}
	throw new Error(`Google Cloud abuse form gave an unrecognized answer: ${snippet(body)}`);
}

type SubmitAttempt = { answer: GoogleCloudSubmitAnswer; sentToken: "v3" | "v2" | undefined };

/** Click Submit once and read the form's own request and Google's answer to it. */
async function submitOnce(page: Page, step: <T>(operation: Promise<T>) => Promise<T>, timeoutMs: number): Promise<SubmitAttempt> {
	const submitResponse = page.waitForResponse(
		(response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(GOOGLE_CLOUD_PROVIDER.submitEndpointPath),
		{ timeout: timeoutMs },
	);
	// Swallow its rejection until it is awaited below, so an earlier failure cannot leave it unhandled.
	submitResponse.catch(() => undefined);
	await step(page.click("button.submit-button"));
	const response = await step(submitResponse).catch(async (error: unknown) => {
		const notification = await formNotification(page);
		throw new Error(`Google Cloud abuse form sent no readable answer${notification ? ` ("${notification}")` : ""}: ${error instanceof Error ? error.message : String(error)}`);
	});
	const sent = jsonRecord(response.request().postData() ?? "");
	const sentToken = typeof sent?.recaptcha_response === "string" && sent.recaptcha_response ? "v2"
		: typeof sent?.recaptcha_response_v3 === "string" && sent.recaptcha_response_v3 ? "v3"
			: undefined;
	return { answer: await step(readGoogleCloudSubmitResponse(response)), sentToken };
}

/**
 * Place a solved checkbox token where the form's own widget keeps it, so the
 * form's next request carries it as `recaptcha_response`.
 */
async function installCheckboxToken(page: Page, token: string): Promise<void> {
	await page.waitForFunction(() => {
		const recaptcha = (window as Window & { grecaptcha?: { getResponse?: unknown } }).grecaptcha;
		return typeof recaptcha?.getResponse === "function" && document.querySelector(".g-recaptcha-v2 iframe") !== null;
	}, { timeout: 20_000 });
	await page.evaluate((value) => {
		const recaptcha = (window as unknown as { grecaptcha: { getResponse: (widget?: unknown) => string } }).grecaptcha;
		recaptcha.getResponse = () => value;
		for (const field of document.querySelectorAll<HTMLTextAreaElement>(".g-recaptcha-v2 textarea[name='g-recaptcha-response']")) field.value = value;
	}, token);
}

/** Fill and send the form from its durable draft, then read Google's confirmation. */
export async function submitGoogleCloudSubmission(
	context: ProviderSubmissionContext,
	dependencies: GoogleCloudSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const payload = googleCloudDraft.stored(context);

	const signal = context.signal;
	const sessionPromise = (dependencies.openPage ?? openReportingPage)();
	const session = await raceAbort(sessionPromise, signal, () => {
		void sessionPromise.then((late) => late.close().catch(() => undefined)).catch(() => undefined);
	}, CANCELED);
	const closeBrowser = () => { void session.close().catch(() => undefined); };
	throwIfOperationCanceled(signal, CANCELED);
	signal?.addEventListener("abort", closeBrowser, { once: true });
	const timeouts = { formReadyMs: FORM_READY_TIMEOUT_MS, submitResponseMs: SUBMIT_RESPONSE_TIMEOUT_MS, confirmationMs: CONFIRMATION_TIMEOUT_MS, ...dependencies.timeouts };
	const step = <T>(operation: Promise<T>) => raceAbort(operation, signal, closeBrowser, CANCELED);
	try {
		const { page } = session;
		await step(page.goto(dependencies.reportPageUrl ?? GOOGLE_CLOUD_PROVIDER.reportPageUrl, { waitUntil: "domcontentloaded" }));
		await step(page.waitForSelector("#abuse_details", { visible: true, timeout: timeouts.formReadyMs }));
		// The form attaches an invisible reCAPTCHA token to its request; a click
		// before reCAPTCHA has loaded sends none, and Google discards the report.
		await step(page.waitForFunction(() => typeof (window as Window & { grecaptcha?: { execute?: unknown } }).grecaptcha?.execute === "function", { timeout: timeouts.formReadyMs }));
		await step(fillGoogleCloudForm(page, payload));

		let attempt = await submitOnce(page, step, timeouts.submitResponseMs);
		if (attempt.answer.outcome === "captcha_required") {
			// Google created no case and switched the form to its checkbox
			// reCAPTCHA. Solve it and send the same form once more.
			const token = await step((dependencies.solveCaptcha ?? solveGoogleCloudCaptcha)(signal));
			await step(installCheckboxToken(page, token));
			attempt = await submitOnce(page, step, timeouts.submitResponseMs);
			if (attempt.answer.outcome === "captcha_required") {
				throw new ProviderSubmissionRejectedError("Google Cloud abuse form rejected the solved reCAPTCHA; no case was created.");
			}
			if (attempt.sentToken !== "v2") throw new Error("The Google Cloud abuse form resent the report without the solved reCAPTCHA token.");
		} else if (!attempt.sentToken) {
			throw new Error("The Google Cloud abuse form sent its report without a reCAPTCHA token.");
		}
		const caseId = attempt.answer.outcome === "accepted" ? attempt.answer.caseId : undefined;
		const confirmation = await step(page.waitForSelector(".confirmation-message__text", { visible: true, timeout: timeouts.confirmationMs }))
			.then((element) => element?.evaluate((node) => (node as HTMLElement).innerText.trim()))
			.catch(() => undefined);
		if (!confirmation) {
			// Google accepted the request but did not confirm a case: ambiguous, never replayed.
			const notification = await formNotification(page);
			throw new Error(`Google Cloud abuse form answered but showed no confirmation${notification ? ` ("${notification}")` : ""}.`);
		}
		return {
			...(caseId ? { confirmationId: caseId } : {}),
			confirmationText: confirmation,
			finalUrl: page.url(),
			submittedTargets: [payload.target.normalizedTarget],
		};
	} finally {
		signal?.removeEventListener("abort", closeBrowser);
		// Cleanup must never discard a confirmed submission.
		await session.close().catch(() => undefined);
	}
}
