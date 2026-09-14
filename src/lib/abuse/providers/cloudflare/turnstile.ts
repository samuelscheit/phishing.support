import type { Browser, BrowserContext, Page } from "patchright";

import { acquireFabricPatchrightSession } from "../../../browser/fabric";
import { CLOUDFLARE_PROVIDER } from "./definition";
import { raceAbort, throwIfOperationCanceled } from "../../worker/cancellation";

const turnstileTimeoutMs = 120_000;
const widgetDiscoveryTimeoutMs = 30_000;
const edgeChallengeTimeoutMs = 75_000;
const maxTurnstileAttempts = 3;

/** Cloudflare's current public phishing-form Turnstile site key. */
export const CLOUDFLARE_TURNSTILE_SITE_KEY = "0x4AAAAAAAa0L843_aKhfEFs";

export type CloudflareTurnstileSession = {
	page: Page;
	context: BrowserContext;
	browser: Browser;
	userAgent: string;
	token: string;
	siteKey: string;
};

/** Identify only Cloudflare's explicit managed edge challenge response. */
export function isCloudflareManagedChallenge(params: { status: number; headers: Record<string, string>; body: string }): boolean {
	return params.status === 403
		&& (params.headers["cf-mitigated"]?.toLowerCase() === "challenge"
			|| /<title>\s*(?:Just a moment|Attention Required)/i.test(params.body));
}

/**
 * Cloudflare can return a managed browser challenge to an XHR instead of
 * navigating the page. Rendering that response in the existing, same-origin
 * page lets Cloudflare's own challenge script establish its clearance cookie;
 * the caller can then repeat the original request once.
 */
export async function resolveCloudflareEdgeChallenge(page: Page, challengeHtml: string, signal?: AbortSignal): Promise<void> {
	if (!challengeHtml.includes("_cf_chl_opt") || !/<title>\s*(?:Just a moment|Attention Required)/i.test(challengeHtml)) {
		throw new Error("Cloudflare returned an unrecognized edge challenge page.");
	}
	throwIfOperationCanceled(signal, "Cloudflare Turnstile preparation was canceled.");
	await raceAbort(page.evaluate((html) => {
		document.open();
		document.write(html);
		document.close();
	}, challengeHtml), signal, () => { void page.close().catch(() => undefined); }, "Cloudflare Turnstile preparation was canceled.");
	await raceAbort(page.waitForFunction(
		() => location.hostname === "abuse.cloudflare.com" && location.pathname === "/phishing" && Boolean(document.querySelector("form")),
		undefined,
		{ timeout: edgeChallengeTimeoutMs },
	), signal, () => { void page.close().catch(() => undefined); }, "Cloudflare Turnstile preparation was canceled.");
}

/**
 * Recent Chromium versions can keep Cloudflare's clearance cookie partitioned
 * after the managed challenge. The form API is same-origin, so mirror that
 * exact session cookie into the ordinary host cookie jar; otherwise Chromium
 * omits it from the subsequent same-origin fetch and Cloudflare challenges the
 * request again.
 */
export async function makeCloudflareClearanceCookieUsable(context: BrowserContext, pageUrl: string): Promise<void> {
	const clearance = (await context.cookies([pageUrl])).find((cookie) => cookie.name === "cf_clearance" && "partitionKey" in cookie && cookie.partitionKey);
	if (!clearance) return;
	await context.addCookies([{
		name: clearance.name,
		value: clearance.value,
		domain: clearance.domain,
		path: clearance.path,
		secure: clearance.secure,
		httpOnly: clearance.httpOnly,
		sameSite: clearance.sameSite,
		expires: clearance.expires,
	}]);
}

/** The consent dialog can sit above the cross-origin challenge frame. */
export async function dismissCloudflareConsentBanner(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.querySelector("#onetrust-consent-sdk")?.remove();
	});
}

export function siteKeyFromFrameUrl(url: string): string | undefined {
	const match = url.match(/(?:^|\/)(0x[A-Za-z0-9_-]{10,})(?:\/|$|\?)/);
	return match?.[1];
}

async function siteKeyFromPage(page: Page): Promise<string | undefined> {
	const dataSiteKeys = await page.locator("[data-sitekey]").evaluateAll((elements) =>
		elements.map((element) => element.getAttribute("data-sitekey")).filter((value): value is string => Boolean(value)),
	);
	return dataSiteKeys.find(Boolean) ?? page.frames().map((frame) => siteKeyFromFrameUrl(frame.url())).find(Boolean);
}

function assertReviewedSiteKey(siteKey: string): string {
	if (siteKey !== CLOUDFLARE_TURNSTILE_SITE_KEY) {
		throw new Error("Cloudflare changed the phishing-form Turnstile site key; automatic reporting is paused until the reviewed key is updated.");
	}
	return siteKey;
}

async function discoverTurnstileSiteKey(page: Page, signal?: AbortSignal): Promise<string> {
	const deadline = Date.now() + widgetDiscoveryTimeoutMs;
	while (Date.now() < deadline) {
		throwIfOperationCanceled(signal, "Cloudflare Turnstile preparation was canceled.");
		const discovered = await siteKeyFromPage(page).catch(() => undefined);
		if (discovered) return assertReviewedSiteKey(discovered);

		// The current form renders the hidden response input before the child
		// frame's URL is exposed. The pinned key is safe as a fallback only when
		// the expected widget container is present.
		if (await page.locator('#turnstile-widget [name="cf-turnstile-response"]').count().catch(() => 0)) {
			return CLOUDFLARE_TURNSTILE_SITE_KEY;
		}
		await raceAbort(page.waitForTimeout(250), signal, () => { void page.close().catch(() => undefined); }, "Cloudflare Turnstile preparation was canceled.");
	}
	throw new Error("Cloudflare phishing form did not render its Turnstile widget.");
}

function rejectedFormError(response: { status(): number; headers(): Record<string, string> }): Error {
	const headers = response.headers();
	const details = [headers["cf-ray"] ? `Ray ID ${headers["cf-ray"]}` : undefined, headers["cf-mitigated"] ? `cf-mitigated=${headers["cf-mitigated"]}` : undefined]
		.filter((value): value is string => Boolean(value))
		.join(", ");
	return new Error(`Cloudflare abuse form load failed with HTTP ${response.status()}${details ? ` (${details})` : ""}.`);
}

/**
 * The Fabric-owned Turnstile guardian performs the only permitted gesture on
 * the reviewed widget. The resulting browser-local response is read just long
 * enough to submit the same-page form; it is never persisted or logged.
 */
export async function readFabricTurnstileToken(page: Page, signal?: AbortSignal, previousToken?: string): Promise<string> {
	const token = await raceAbort(
		(async () => {
			await page.waitForFunction(
				(previous) => {
					const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
						'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
					));
					return fields
						.map((field) => field.value.trim())
						.some((value) => value.length >= 20 && value.length <= 16_384 && value !== previous);
				},
				previousToken,
				{ timeout: turnstileTimeoutMs },
			);
			return await page.evaluate(() => {
				const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
					'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
				));
				return fields.map((field) => field.value.trim()).find((value) => value.length >= 20 && value.length <= 16_384) ?? "";
			});
		})(),
		signal,
		() => { void page.close().catch(() => undefined); },
		"Cloudflare Turnstile preparation was canceled.",
	);
	if (!token || token.length > 16_384) throw new Error("Fabric Turnstile guardian did not produce a valid response token.");
	return token;
}

/**
 * Open Cloudflare's form in a Fabric-owned Chromium lease and obtain the
 * browser-local response produced by Fabric's guardian. Browser egress,
 * challenge interaction, and proxy affinity stay inside Fabric.
 */
async function solveCloudflareAbuseTurnstileOnce(signal?: AbortSignal): Promise<CloudflareTurnstileSession> {
	const launch = acquireFabricPatchrightSession(
		{ operation: "cloudflare-turnstile" },
		{ leaseMode: "clone" },
	);
	const fabricSession = await raceAbort(launch, signal, () => {
		void launch.then((late) => late.cancel().catch(() => undefined)).catch(() => undefined);
	}, "Cloudflare Turnstile preparation was canceled.");
	const browser = fabricSession.browser as Browser;
	const context = fabricSession.context as BrowserContext;

	try {
		throwIfOperationCanceled(signal, "Cloudflare Turnstile preparation was canceled.");

		const page = await raceAbort(context.newPage(), signal, () => { void browser.close().catch(() => undefined); }, "Cloudflare Turnstile preparation was canceled.");

		const navigation = page.goto(CLOUDFLARE_PROVIDER.formUrl, { waitUntil: "domcontentloaded", timeout: turnstileTimeoutMs });
		const response = await raceAbort(navigation, signal, () => { void browser.close().catch(() => undefined); }, "Cloudflare Turnstile preparation was canceled.");
		if (!response) throw new Error("Cloudflare abuse form navigation returned no response.");
		const responseHeaders = response.headers();
		const responseBody = response.status() === 403 ? await response.text() : "";
		const managedChallenge = isCloudflareManagedChallenge({ status: response.status(), headers: responseHeaders, body: responseBody });
		if (!response.ok() && !managedChallenge) throw rejectedFormError(response);
		if (managedChallenge) await resolveCloudflareEdgeChallenge(page, responseBody, signal);
		await dismissCloudflareConsentBanner(page).catch(() => undefined);
		await makeCloudflareClearanceCookieUsable(context, CLOUDFLARE_PROVIDER.formUrl).catch(() => undefined);

		const siteKey = await discoverTurnstileSiteKey(page, signal);
		const userAgent = await raceAbort(page.evaluate(() => navigator.userAgent), signal, () => { void browser.close().catch(() => undefined); }, "Cloudflare Turnstile preparation was canceled.");
		if (!userAgent.trim()) throw new Error("Cloudflare browser session did not expose a user agent.");
		const token = await readFabricTurnstileToken(page, signal);

		return { page, context, browser, userAgent, token, siteKey };
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}

/**
 * Obtain a token with a fresh Fabric browser lease when the current guardian
 * cannot complete the reviewed widget. All attempts happen before the provider
 * submission marker, so retrying cannot duplicate a complaint.
 */
export async function solveCloudflareAbuseTurnstile(
	options: { signal?: AbortSignal } = {},
): Promise<CloudflareTurnstileSession> {
	let lastError: unknown;
	for (let attempt = 0; attempt < maxTurnstileAttempts; attempt += 1) {
		try {
			throwIfOperationCanceled(options.signal, "Cloudflare Turnstile preparation was canceled.");
			return await solveCloudflareAbuseTurnstileOnce(options.signal);
		} catch (error) {
			lastError = error;
			if (attempt + 1 < maxTurnstileAttempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
