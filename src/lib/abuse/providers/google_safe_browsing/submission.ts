import anticaptcha from "@antiadmin/anticaptchaofficial";

import { getBrowserPage } from "../../../browser";
import { providerDefinitionMatchesPin } from "../definition";
import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { routeContext } from "../../worker/shared";
import { raceAbort, throwIfOperationCanceled } from "../../worker/cancellation";
import { GOOGLE_SAFE_BROWSING_PROVIDER } from "./definition";
import {
	buildGoogleSafeBrowsingSubmissionPayload,
	storedGoogleSafeBrowsingSubmissionPayload,
} from "./payload";

type GoogleSafeBrowsingPage = Awaited<ReturnType<typeof getBrowserPage>>["page"];
type GoogleSafeBrowsingBrowserSession = Awaited<ReturnType<typeof getBrowserPage>>;

export type GoogleSafeBrowsingSubmissionStatus = {
	success: boolean;
	failure: boolean;
	text: string;
	html: string;
};

type AntiCaptchaClient = Pick<typeof anticaptcha, "setAPIKey" | "solveRecaptchaV3">;

export type GoogleSafeBrowsingSubmissionDependencies = {
	getBrowserPage?: () => Promise<GoogleSafeBrowsingBrowserSession>;
	sleep?: (milliseconds: number) => Promise<void>;
	antiCaptcha?: AntiCaptchaClient;
	antiCaptchaApiKey?: string | undefined;
};

export function googleSafeBrowsingReportUrl(url: string): string {
	const reportUrl = new URL(GOOGLE_SAFE_BROWSING_PROVIDER.reportPageUrl);
	reportUrl.searchParams.set("hl", "de");
	reportUrl.searchParams.set("url", url);
	return reportUrl.toString();
}

/** Block only the scripts that would replace an injected solved token. */
export function shouldBlockGoogleRecaptchaScript(url: string): boolean {
	return (
		(url.includes("https://www.google.com/recaptcha/api") || url.includes("https://www.gstatic.com/recaptcha/releases"))
		&& url.includes(".js")
	);
}

async function configureRecaptchaRequestInterception(page: GoogleSafeBrowsingPage): Promise<void> {
	await page.setRequestInterception(true);
	page.on("request", (request) => {
		const action = shouldBlockGoogleRecaptchaScript(request.url()) ? request.abort() : request.continue();
		void action.catch(() => undefined);
	});
}

async function solveRecaptchaToken(params: {
	reportUrl: string;
	antiCaptcha: AntiCaptchaClient;
	apiKey: string;
}): Promise<string> {
	params.antiCaptcha.setAPIKey(params.apiKey);
	const token = await params.antiCaptcha.solveRecaptchaV3(
		params.reportUrl,
		GOOGLE_SAFE_BROWSING_PROVIDER.recaptcha.siteKey,
		GOOGLE_SAFE_BROWSING_PROVIDER.recaptcha.minimumScore,
		GOOGLE_SAFE_BROWSING_PROVIDER.recaptcha.action,
	);
	if (!token?.trim()) throw new Error("Anti-Captcha did not return a Google Safe Browsing reCAPTCHA token.");
	return token;
}

/** The token is installed after navigation; installing it before navigation loses it to the page load. */
async function installRecaptchaToken(page: GoogleSafeBrowsingPage, token: string): Promise<void> {
	await page.evaluate((captchaToken) => {
		type Recaptcha = {
			execute(sitekey: string, parameters: unknown): Promise<string>;
			ready(callback: () => void): void;
			enterprise?: Recaptcha;
		};

		const recaptcha: Recaptcha = {
			execute: async () => captchaToken,
			ready: (callback) => callback(),
		};
		recaptcha.enterprise = recaptcha;
		(window as Window & { grecaptcha?: Recaptcha }).grecaptcha = recaptcha;
	}, token);
}

async function pressSubmit(page: GoogleSafeBrowsingPage, pause: (milliseconds: number) => Promise<void>): Promise<void> {
	await page.focus('button[type="submit"]');
	await pause(750);
	await page.keyboard.press("Enter");
}

export async function readGoogleSafeBrowsingSubmissionStatus(page: GoogleSafeBrowsingPage): Promise<GoogleSafeBrowsingSubmissionStatus> {
	const card = await page.waitForSelector(".form-status-card");
	if (!card) throw new Error("Failed to find submission status card on Google Safe Browsing report page.");
	const [successIndicator, failureIndicator] = await Promise.all([
		card.$(".success"),
		card.$(".failure"),
	]);
	const [success, failure] = await Promise.all([
		successIndicator?.isVisible() ?? false,
		failureIndicator?.isVisible() ?? false,
	]);

	return {
		success,
		failure,
		text: await card.$eval("mat-card-content", (element) => element.textContent?.trim() || ""),
		html: await card.evaluate((element) => element.outerHTML),
	};
}

/**
 * Google visibly permits a second form attempt. Keep that bounded inside one
 * marked run; worker retries never replay browser submissions after a crash.
 */
export async function submitGoogleSafeBrowsingForm(params: {
	pressSubmit: () => Promise<void>;
	readStatus: () => Promise<GoogleSafeBrowsingSubmissionStatus>;
	pause: (milliseconds: number) => Promise<void>;
}): Promise<GoogleSafeBrowsingSubmissionStatus> {
	let lastFailure: GoogleSafeBrowsingSubmissionStatus | undefined;
	for (let attempt = 0; attempt < GOOGLE_SAFE_BROWSING_PROVIDER.maximumSubmitAttempts; attempt += 1) {
		await params.pressSubmit();
		const status = await params.readStatus();
		if (status.success && !status.failure) return status;
		if (!status.failure || status.success) {
			throw new Error(`Google Safe Browsing report submission status is unknown: ${status.html}`);
		}
		lastFailure = status;
		if (attempt + 1 < GOOGLE_SAFE_BROWSING_PROVIDER.maximumSubmitAttempts) await params.pause(3_000);
	}
	throw new ProviderSubmissionRejectedError(
		`Google Safe Browsing report rejected after ${GOOGLE_SAFE_BROWSING_PROVIDER.maximumSubmitAttempts} attempts: ${lastFailure?.text || "unknown provider response"}`,
	);
}

/** Enforce the supplemental provider's domain + observed-URL eligibility before its marker. */
export async function prepareGoogleSafeBrowsingSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const { route, report, target } = await routeContext(context.routeId);
	if (route.routeType !== "provider_submission" || route.providerRegistryKey !== GOOGLE_SAFE_BROWSING_PROVIDER.key
		|| target.targetType !== "domain") {
		return { outcome: "insufficient_evidence", reason: "google_safe_browsing_requires_a_domain_target" };
	}
	if (!providerDefinitionMatchesPin(GOOGLE_SAFE_BROWSING_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "google_safe_browsing_provider_definition_pin_mismatch" };
	}
	const observedUrl = target.observedUrls[0];
	if (!observedUrl) return { outcome: "insufficient_evidence", reason: "google_safe_browsing_requires_an_observed_url" };
	const payload = buildGoogleSafeBrowsingSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl,
		description: report.description,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
	});
	if (!payload) return { outcome: "insufficient_evidence", reason: "google_safe_browsing_report_payload_invalid" };
	return { outcome: "ready", payload };
}

/** Perform the marked Google Safe Browsing form submission from its durable payload. */
export async function submitGoogleSafeBrowsingSubmission(
	context: ProviderSubmissionContext,
	dependencies: GoogleSafeBrowsingSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const payload = storedGoogleSafeBrowsingSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Google Safe Browsing submission payload is malformed.");
	const { route, report, target } = await routeContext(context.routeId);
	if (route.routeType !== "provider_submission" || route.providerRegistryKey !== GOOGLE_SAFE_BROWSING_PROVIDER.key
		|| !providerDefinitionMatchesPin(GOOGLE_SAFE_BROWSING_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)
		|| target.targetType !== "domain"
		|| target.normalizedTarget !== payload.target.normalizedTarget || !target.observedUrls.includes(payload.target.observedUrl)) {
		throw new Error("The persisted Google Safe Browsing payload no longer matches its route.");
	}
	const expected = buildGoogleSafeBrowsingSubmissionPayload({
		target: target.normalizedTarget,
		observedUrl: payload.target.observedUrl,
		description: report.description,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
	});
	if (!expected || expected.report.explanation !== payload.report.explanation) {
		throw new Error("The persisted Google Safe Browsing payload no longer matches the report evidence.");
	}

	const reportUrl = googleSafeBrowsingReportUrl(payload.target.observedUrl);
	const sessionPromise = (dependencies.getBrowserPage ?? getBrowserPage)();
	const session = await raceAbort(
		sessionPromise,
		context.signal,
		() => {
			void sessionPromise.then((lateSession) => lateSession.browser.close().catch(() => undefined)).catch(() => undefined);
		},
		"Google Safe Browsing submission was canceled.",
	);
	const closeBrowser = () => { void session.browser.close().catch(() => undefined); };
	const signal = context.signal;
	throwIfOperationCanceled(signal, "Google Safe Browsing submission was canceled.");
	signal?.addEventListener("abort", closeBrowser, { once: true });
	try {
		const apiKey = dependencies.antiCaptchaApiKey ?? process.env.ANTICAPTCHA_API_KEY;
		const antiCaptcha = dependencies.antiCaptcha ?? anticaptcha;
		const token = apiKey?.trim()
			? await raceAbort(
				solveRecaptchaToken({ reportUrl, antiCaptcha, apiKey: apiKey.trim() }),
				signal,
				closeBrowser,
				"Google Safe Browsing submission was canceled.",
			)
			: undefined;
		if (token) await configureRecaptchaRequestInterception(session.page);

		await raceAbort(session.page.goto(reportUrl, { waitUntil: "domcontentloaded" }), signal, closeBrowser, "Google Safe Browsing submission was canceled.");
		if (token) await raceAbort(installRecaptchaToken(session.page, token), signal, closeBrowser, "Google Safe Browsing submission was canceled.");
		await raceAbort(session.page.waitForSelector("#mat-input-0"), signal, closeBrowser, "Google Safe Browsing submission was canceled.");
		await raceAbort(session.page.type("#mat-input-1", payload.report.explanation), signal, closeBrowser, "Google Safe Browsing submission was canceled.");
		const success = await submitGoogleSafeBrowsingForm({
			pressSubmit: () => raceAbort(
				pressSubmit(session.page, dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))),
				signal,
				closeBrowser,
				"Google Safe Browsing submission was canceled.",
			),
			readStatus: () => raceAbort(
				readGoogleSafeBrowsingSubmissionStatus(session.page),
				signal,
				closeBrowser,
				"Google Safe Browsing submission was canceled.",
			),
			pause: dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
		});
		return {
			confirmationText: success.text || "Google Safe Browsing accepted the phishing report.",
			finalUrl: session.page.url(),
			submittedTargets: [payload.target.normalizedTarget],
		};
	} finally {
		signal?.removeEventListener("abort", closeBrowser);
		// Cleanup must not discard a provider-confirmed success and cause a
		// duplicate-risk replay. The browser is nevertheless closed exactly once.
		await session.browser.close().catch(() => undefined);
	}
}
