import { chromium, type Browser, type BrowserContext, type Page } from "patchright";

import { solveDeathByCaptchaToken } from "../../captcha/death_by_captcha";
import { getChromeExecutablePath, getChromiumSandboxArgs } from "../../../browser/browser";
import { getProviderProxy, withIproyalStickySession, type ProviderProxy } from "../proxy";
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
	proxy: ProviderProxy;
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
 * Open Cloudflare's form and obtain a short-lived Turnstile token through the
 * documented Death by Captcha token API. The supplied HTTP proxy is passed to
 * both systems so the solver and the eventual form request use the same exit
 * network identity.
 */
async function solveCloudflareAbuseTurnstileOnce(proxy: ProviderProxy, signal?: AbortSignal): Promise<CloudflareTurnstileSession> {
	const executablePath = getChromeExecutablePath();
	const browserLaunch = chromium.launch({
		...(executablePath ? { executablePath } : {}),
		headless: process.env.BROWSER_HEADLESS === "true",
		args: getChromiumSandboxArgs(),
		proxy: proxy.browser,
	});
	const browser = await raceAbort(browserLaunch, signal, () => {
		void browserLaunch.then((lateBrowser) => lateBrowser.close().catch(() => undefined)).catch(() => undefined);
	}, "Cloudflare Turnstile preparation was canceled.");

	try {
		throwIfOperationCanceled(signal, "Cloudflare Turnstile preparation was canceled.");
		const context = await browser.newContext({
			ignoreHTTPSErrors: true,
			locale: "en-US",
			viewport: { width: 1920, height: 1080 },
		});

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
		const token = await solveDeathByCaptchaToken({
			type: 12,
			parametersField: "turnstile_params",
			parameters: {
				proxy: proxy.url,
				proxytype: "HTTP",
				sitekey: siteKey,
				pageurl: CLOUDFLARE_PROVIDER.formUrl,
			},
			signal,
		});

		return { page, context, browser, proxy, userAgent, token, siteKey };
	} catch (error) {
		await browser.close().catch(() => undefined);
		throw error;
	}
}

/**
 * Obtain a token with a fresh IPRoyal session when a rotating exit is blocked
 * or the browser/solver connection drops. All attempts happen before the
 * provider submission marker, so retrying cannot duplicate a complaint.
 */
export async function solveCloudflareAbuseTurnstile(
	proxy: ProviderProxy = getProviderProxy("Cloudflare abuse reporting"),
	options: { signal?: AbortSignal } = {},
): Promise<CloudflareTurnstileSession> {
	if (proxy.captchaType !== "HTTP") {
		throw new Error("Cloudflare Turnstile solving requires an HTTP proxy; configure PROXY_URL with an HTTP endpoint.");
	}

	let lastError: unknown;
	for (let attempt = 0; attempt < maxTurnstileAttempts; attempt += 1) {
		try {
			throwIfOperationCanceled(options.signal, "Cloudflare Turnstile preparation was canceled.");
			// IPRoyal's default gateway rotates on every connection. Turnstile
			// tokens are IP-bound, so use one stable session for this browser and
			// its DBC solve; a later attempt receives a new session/exit IP.
			return await solveCloudflareAbuseTurnstileOnce(withIproyalStickySession(proxy), options.signal);
		} catch (error) {
			lastError = error;
			if (attempt + 1 < maxTurnstileAttempts) await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
