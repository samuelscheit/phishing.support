import { type HTTPResponse, type Page, TimeoutError } from "rebrowser-puppeteer-core";

import { sleep } from "../../util/sleep";

/** How long an HTTP error document may take to replace itself, e.g. a JavaScript bot-check interstitial. */
export const WEBSITE_ERROR_DOCUMENT_SETTLE_MS = 20_000;
const WEBSITE_ERROR_DOCUMENT_POLL_MS = 500;
/** How long a document the page's own script navigated to may take to be parsed. */
const WEBSITE_SCRIPTED_DOCUMENT_PARSE_MS = 5_000;
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
		if (response?.ok() && await isParsed(page, response)) return response;
	}
	return null;
}

/** Whether the main frame holds the response's document, parsed. */
async function isParsed(page: Page, response: HTTPResponse): Promise<boolean> {
	const readyState = await page.evaluate(() => document.readyState).catch(() => "loading");
	return readyState !== "loading" && page.url() === response.url();
}

/**
 * A main-frame navigation the loaded page started by itself while it loaded
 * or rendered (for example `location.href = ...` after a server-side visitor
 * check): the destination's response once its document is parsed, rendered
 * like the page before it, or undefined when the page stayed put (or its
 * destination failed, which leaves Chromium's own error document).
 */
export async function followScriptedDocument(page: Page, latestDocumentResponse: HTTPResponse | null, loadedResponse: HTTPResponse | null, renderSettleMs: number): Promise<HTTPResponse | undefined> {
	if (!latestDocumentResponse || latestDocumentResponse === loadedResponse || !latestDocumentResponse.ok()) return undefined;
	const deadline = Date.now() + WEBSITE_SCRIPTED_DOCUMENT_PARSE_MS;
	while (!await isParsed(page, latestDocumentResponse)) {
		if (Date.now() >= deadline) return undefined;
		await sleep(WEBSITE_ERROR_DOCUMENT_POLL_MS / 10);
	}
	await settleRendering(page, renderSettleMs);
	return latestDocumentResponse;
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

