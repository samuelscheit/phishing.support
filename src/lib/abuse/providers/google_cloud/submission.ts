import type { HTTPResponse, Page } from "rebrowser-puppeteer-core";

import { getBrowser, getBrowserPage } from "../../../browser";
import { CaptchaError, waitForCaptchaToken } from "../../../browser/captcha_state";
import { abuseEmailCaseUrl } from "../../mail/draft";
import { raceAbort, throwIfOperationCanceled } from "../../worker/cancellation";
import { createDraft, type RouteData, type VerifiedOf } from "../kit/draft";
import { preparedState, withPreflight } from "../kit/session";
import { snippet } from "../../../util/text";
import { emailOriginOf } from "../email_origin";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { GOOGLE_CLOUD_PROVIDER } from "./definition";
import {
	buildGoogleCloudSubmissionPayload,
	storedGoogleCloudSubmissionPayload,
	type GoogleCloudReportInput,
	type GoogleCloudSubmissionPayload,
} from "./payload";
import { parseJsonRecord } from "../../../util/values";

const CANCELED = "Google Cloud abuse report submission was canceled.";
const FORM_READY_TIMEOUT_MS = 45_000;
const SUBMIT_RESPONSE_TIMEOUT_MS = 60_000;
const CONFIRMATION_TIMEOUT_MS = 20_000;
/** How long the browser's solver may take on the checkbox reCAPTCHA: its image rounds, then Fabric's DeathByCaptcha fallback. */
const CHECKBOX_TIMEOUT_MS = 240_000;
/** The checkbox widget's frame, which the form adds under its `.g-recaptcha-v2` container. */
const CHECKBOX_WIDGET = ".g-recaptcha-v2 iframe";

type GoogleCloudFormSession = { page: Page; close(): Promise<void> };
type GoogleCloudTimeouts = { formReadyMs: number; submitResponseMs: number; confirmationMs: number; checkboxMs: number };

export type GoogleCloudSubmissionDependencies = {
	/** A Fabric page on the direct reporting egress (Google's form challenges Tor exits), whose solver passes the checkbox reCAPTCHA. */
	openPage?: () => Promise<GoogleCloudFormSession>;
	reportPageUrl?: string;
	timeouts?: Partial<GoogleCloudTimeouts>;
};

/** The filled form the preflight leaves for the irreversible click. Never persisted. */
type GoogleCloudPreflightState = { session: GoogleCloudFormSession; timeouts: GoogleCloudTimeouts };

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
	const json = parseJsonRecord(body.replace(/^\)\]\}'[^\n]*\n/, ""));
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
	const sent = parseJsonRecord(response.request().postData() ?? "");
	const sentToken = typeof sent?.recaptcha_response === "string" && sent.recaptcha_response ? "v2"
		: typeof sent?.recaptcha_response_v3 === "string" && sent.recaptcha_response_v3 ? "v3"
			: undefined;
	return { answer: await step(readGoogleCloudSubmitResponse(response)), sentToken };
}

/**
 * Wait for the browser's solver to pass the checkbox reCAPTCHA the form shows
 * after `REQUIRED_RECAPTCHA`; the widget then holds the token the form's next
 * request carries as `recaptcha_response`. Google created no case, so a
 * solver that fails leaves nothing filed: a person takes it from there.
 */
async function waitForCheckbox(page: Page, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
	await waitForCaptchaToken(page, GOOGLE_CLOUD_PROVIDER.captcha.kind, {
		label: "Google Cloud's checkbox reCAPTCHA",
		tokenSelector: GOOGLE_CLOUD_PROVIDER.captcha.tokenSelector,
		// Kept in view, so the solver can see and click it.
		widgetSelector: CHECKBOX_WIDGET,
		timeoutMs,
		...(signal ? { signal } : {}),
	}).catch((error: unknown) => {
		if (error instanceof CaptchaError) throw new ProviderSubmissionNeedsHumanError(`${error.message}; Google created no case.`);
		throw error;
	});
}

/** A session whose close runs once and never throws, so abort, a failed preflight and the executor's dispose may all call it. */
function closingOnce(session: GoogleCloudFormSession): GoogleCloudFormSession {
	let closing: Promise<void> | undefined;
	return { page: session.page, close: () => (closing ??= session.close().catch(() => undefined)) };
}

/** Run `operation` unless `signal` aborts first; an abort closes the browser, so no later step can reach Google. */
function abortableStep(session: GoogleCloudFormSession, signal: AbortSignal | undefined) {
	return <T>(operation: Promise<T>) => raceAbort(operation, signal, () => { void session.close(); }, CANCELED);
}

/**
 * Before the marker, none of which sends anything to Google: open the
 * browser, load the form, wait until it and its invisible reCAPTCHA are ready
 * and fill it from the durable draft. Every failure here (a browser that does
 * not start, a form that never loads) is a plain retry; the browser is closed.
 */
export async function prepareGoogleCloudExternalSubmission(
	context: ProviderSubmissionContext,
	{ payload }: VerifiedOf<typeof googleCloudDraft>,
	dependencies: GoogleCloudSubmissionDependencies = {},
): Promise<ProviderSubmissionPreflight> {
	const { signal } = context;
	const timeouts: GoogleCloudTimeouts = { formReadyMs: FORM_READY_TIMEOUT_MS, submitResponseMs: SUBMIT_RESPONSE_TIMEOUT_MS, confirmationMs: CONFIRMATION_TIMEOUT_MS, checkboxMs: CHECKBOX_TIMEOUT_MS, ...dependencies.timeouts };
	const open = async () => {
		const opening = (dependencies.openPage ?? openReportingPage)().then(closingOnce);
		return raceAbort(opening, signal, () => {
			void opening.then((late) => late.close()).catch(() => undefined);
		}, CANCELED);
	};
	return withPreflight(open, async (session): Promise<GoogleCloudPreflightState> => {
		const step = abortableStep(session, signal);
		const { page } = session;
		await step(page.goto(dependencies.reportPageUrl ?? GOOGLE_CLOUD_PROVIDER.reportPageUrl, { waitUntil: "domcontentloaded" }));
		await step(page.waitForSelector("#abuse_details", { visible: true, timeout: timeouts.formReadyMs }));
		// The form attaches an invisible reCAPTCHA token to its request; a click
		// before reCAPTCHA has loaded sends none, and Google discards the report.
		await step(page.waitForFunction(() => typeof (window as Window & { grecaptcha?: { execute?: unknown } }).grecaptcha?.execute === "function", { timeout: timeouts.formReadyMs }));
		await step(fillGoogleCloudForm(page, payload));
		return { session, timeouts };
	});
}

/**
 * After the marker: click Submit on the prepared form and read Google's
 * answer, sending it once more when Google asks for the checkbox reCAPTCHA.
 * The executor disposes the preflight (closes the browser) afterwards.
 */
export async function submitGoogleCloudSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight): Promise<ProviderSubmissionSuccess> {
	const { session, timeouts } = preparedState<GoogleCloudPreflightState>(
		preflight,
		(state) => typeof state.session?.page === "object" && typeof state.timeouts === "object",
		"Google Cloud submission requires its prepared form page.",
	);
	const payload = googleCloudDraft.stored(context);
	const { signal } = context;
	const step = abortableStep(session, signal);
	const { page } = session;
	throwIfOperationCanceled(signal, CANCELED);
	let attempt = await submitOnce(page, step, timeouts.submitResponseMs);
	if (attempt.answer.outcome === "captcha_required") {
		// Google created no case and switched the form to its checkbox
		// reCAPTCHA. The browser's solver passes it; send the same form once more.
		await step(waitForCheckbox(page, timeouts.checkboxMs, signal));
		attempt = await submitOnce(page, step, timeouts.submitResponseMs);
		if (attempt.answer.outcome === "captcha_required") {
			// Nothing was filed and the report itself is fine: a person can send it.
			throw new ProviderSubmissionNeedsHumanError("Google Cloud abuse form asked for the reCAPTCHA again after the solved one; no case was created.");
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
}
