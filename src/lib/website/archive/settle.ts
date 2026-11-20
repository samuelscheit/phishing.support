import { type HTTPResponse, type Page, TimeoutError } from "rebrowser-puppeteer-core";

import { sleep } from "../../sleep";

/** How long an HTTP error document may take to replace itself, e.g. a JavaScript bot-check interstitial. */
export const WEBSITE_ERROR_DOCUMENT_SETTLE_MS = 20_000;
const WEBSITE_ERROR_DOCUMENT_POLL_MS = 500;
/** How long a loaded page may take before its own script navigates the main frame elsewhere. */
export const WEBSITE_SCRIPT_NAVIGATION_SETTLE_MS = 8_000;
/** How long the captured document may keep fetching what it renders before it is captured as it stands. */
export const WEBSITE_RENDER_SETTLE_MS = 10_000;
/** A quiet network for this long means the page's script has fetched what it renders. */
export const WEBSITE_RENDER_IDLE_MS = 1_000;
/** Requests that may stay open while the page counts as rendered: analytics beacons, long polls, captcha widgets. */
const WEBSITE_RENDER_IDLE_CONCURRENCY = 2;

/**
 * Bot-check interstitials answer with 403/503 and then reload or redirect to
 * the real page once their script passes. Follow the main frame until it holds
 * a successful, parsed document, or give up after a bounded wait.
 */
export async function settleErrorDocument(page: Page, latestDocumentResponse: () => HTTPResponse | null, settleMs: number): Promise<HTTPResponse | null> {
	const deadline = Date.now() + settleMs;
	while (Date.now() < deadline) {
		await sleep(WEBSITE_ERROR_DOCUMENT_POLL_MS);
		const response = latestDocumentResponse();
		if (!response?.ok()) continue;
		const readyState = await page.evaluate(() => document.readyState).catch(() => "loading");
		if (readyState !== "loading" && page.url() === response.url()) return response;
	}
	return null;
}

/**
 * Follow a main-frame navigation the loaded page starts by itself (for example
 * `location.href = ...` after a server-side visitor check). Returns the new
 * document's response once it is parsed, or undefined when the page stays put.
 */
export async function settleScriptNavigation(
	page: Page,
	latestDocumentResponse: () => HTTPResponse | null,
	loadedResponse: HTTPResponse | null,
	settleMs: number,
): Promise<HTTPResponse | undefined> {
	const deadline = Date.now() + settleMs;
	while (Date.now() < deadline) {
		await sleep(WEBSITE_ERROR_DOCUMENT_POLL_MS);
		const response = latestDocumentResponse();
		if (!response || response === loadedResponse || !response.ok()) continue;
		const readyState = await page.evaluate(() => document.readyState).catch(() => "loading");
		if (readyState !== "loading" && page.url() === response.url()) return response;
	}
	return undefined;
}

/**
 * Site builders and single-page apps serve a shell and build the visible page
 * (a login form, for example) from XHR responses after DOMContentLoaded. Wait
 * until those requests are done so the capture holds what a visitor sees, but
 * never let a request that stays open hold the analysis: past the bound, the
 * document is captured as it stands.
 */
export async function settleRendering(page: Page, settleMs: number): Promise<void> {
	await page.waitForNetworkIdle({ idleTime: Math.min(WEBSITE_RENDER_IDLE_MS, settleMs), concurrency: WEBSITE_RENDER_IDLE_CONCURRENCY, timeout: settleMs }).catch((error: unknown) => {
		if (!(error instanceof TimeoutError)) throw error;
	});
}

