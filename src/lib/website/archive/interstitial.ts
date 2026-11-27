import type { HTTPResponse, Page } from "rebrowser-puppeteer-core";

import { classifyBareErrorPage } from "../../network/error_page";
import { sleep } from "../../util/sleep";
import { squash } from "../../util/text";
import { CLOUDFLARE_BYPASS_FORM } from "../analysis/provider_warning";
import { isParsed } from "./settle";

/**
 * What stands before a site instead of it: a bot-check challenge that
 * replaces itself with the site once passed, a provider's warning, or a
 * network turned away (a WAF block, a bare gateway error). Every judgment is
 * by what the page is (its headers, its DOM, the browser's solver), never by
 * its HTTP status: a challenge answers 200 as readily as 403, and a kit's own
 * page answers 403, 404 or 500.
 */

/** How long an interstitial (a bot check, a dismissed provider warning) may take to be replaced by the page behind it. */
export const WEBSITE_INTERSTITIAL_SETTLE_MS = 20_000;
const WEBSITE_INTERSTITIAL_POLL_MS = 500;
/** Of a page's text and markup, this much is read: an error or challenge page is small. */
const MAX_PROBED_TEXT = 5_000;
const MAX_PROBED_HTML = 200_000;

/**
 * Elements only a vendor's challenge interstitial carries, by vendor. Never
 * a widget or sensor a normal page embeds: a kit's own Turnstile
 * (challenges.cloudflare.com, which the verification gate handles), Cloudflare's
 * passive JS detection, PerimeterX's or AWS WAF's sensor scripts. Titles
 * ("Just a moment...") decide nothing: fake verification gates copy them.
 */
const CHALLENGE_ELEMENTS: Record<string, string> = {
	Cloudflare: '#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running, .cf-browser-verification, script[src*="/cdn-cgi/challenge-platform/"][src*="orchestrate"]',
	Vercel: "#vercel-challenge",
	"AWS WAF": 'script[src*="awswaf"][src*="captcha"], script[src*="awswaf"][src*="challenge"]',
	Imperva: 'iframe[src*="_Incapsula_Resource"]',
	DataDome: 'script[src*="captcha-delivery.com"], iframe[src*="captcha-delivery.com"]',
	"DDoS-Guard": 'img[src*="ddos-guard"], script[src*="check.ddos-guard.net"], #ddg-l10n-title, #ddg-captcha, .ddg-captcha',
	PerimeterX: "#px-captcha",
};
/** Globals only a vendor's challenge interstitial declares, by vendor. */
const CHALLENGE_GLOBALS: Record<string, string[]> = {
	Cloudflare: ["_cf_chl_opt"],
	"AWS WAF": ["gokuProps", "AwsWafCaptcha"],
};
/** Response headers by which a CDN says it answered with a challenge. */
const CHALLENGE_HEADERS: Array<[header: string, vendor: string]> = [["cf-mitigated", "Cloudflare"], ["x-vercel-mitigated", "Vercel"], ["x-amzn-waf-action", "AWS WAF"]];

/** What the main frame's document shows, as far as a challenge or an error page tells. */
export type PageState = {
	/** The browser's captcha solver on the document (`data-captcha-state`). */
	captchaState: string | null;
	title: string;
	text: string;
	html: string;
	/** Whether a visitor could enter anything: such a page is the site, a captcha widget on it or not. */
	fields: boolean;
	/** The vendors whose challenge elements or globals the document carries. */
	vendors: string[];
	/** Whether Cloudflare's phishing warning stands there still: its Turnstile already had its wait. */
	bypass: boolean;
};

/** Runs in the page: what `PageState` says of it. Exported so a fake page can answer it. */
export function pageStateProbe(probe: { elements: Record<string, string>; globals: Record<string, string[]>; bypass: string; maxText: number; maxHtml: number }): PageState {
	const fields = [...document.querySelectorAll("input, textarea, select")].some((element) => {
		const type = (element.getAttribute("type") ?? "").toLowerCase();
		return !["hidden", "submit", "button", "reset", "image"].includes(type) && element.getClientRects().length > 0;
	});
	const vendors = Object.keys({ ...probe.elements, ...probe.globals }).filter((vendor) =>
		(probe.elements[vendor] !== undefined && document.querySelector(probe.elements[vendor]!) !== null)
		|| (probe.globals[vendor] ?? []).some((name) => name in window));
	return {
		captchaState: document.documentElement.getAttribute("data-captcha-state"),
		title: document.title,
		text: (document.body?.innerText ?? "").slice(0, probe.maxText),
		html: document.documentElement.outerHTML.slice(0, probe.maxHtml),
		fields,
		vendors,
		bypass: document.querySelector(probe.bypass) !== null,
	};
}

/** The main frame's document as it stands; undefined while it cannot be read (it is being replaced). */
export async function readPageState(page: Page): Promise<PageState | undefined> {
	return page.evaluate(pageStateProbe, { elements: CHALLENGE_ELEMENTS, globals: CHALLENGE_GLOBALS, bypass: CLOUDFLARE_BYPASS_FORM, maxText: MAX_PROBED_TEXT, maxHtml: MAX_PROBED_HTML }).catch(() => undefined);
}

/** The vendor whose challenge the response's headers name. */
export function headerChallenge(response: HTTPResponse): string | undefined {
	const headers = response.headers();
	return CHALLENGE_HEADERS.find(([header]) => /challenge|captcha/i.test(headers[header] ?? ""))?.[1];
}

/**
 * The vendor whose bot check the document is: the browser's solver working
 * on it, or a page without anything to fill in that carries a vendor's
 * challenge elements. Cloudflare's phishing warning is none (it had its
 * wait), nor is a page whose challenge the solver passed.
 */
export function shownChallenge(state: PageState | undefined): string | undefined {
	if (!state || state.bypass || state.captchaState === "solved") return undefined;
	if (state.captchaState === "solving") return state.vendors[0] ?? "captcha";
	return state.fields ? undefined : state.vendors[0];
}

/**
 * The document that replaced an interstitial standing before the site, once
 * parsed: after a provider's warning was dismissed (`dismissed`), or after a
 * bot check passed and reloaded or redirected into the site. Any HTTP status
 * counts: the page behind a challenge may answer 500 itself. Undefined when
 * the loaded document is no interstitial, nothing replaced it within
 * `settleMs`, the solver failed, the challenge cleared in place, or `signal`
 * aborted: the loaded document is then the page as it stands.
 */
export async function settleInterstitial(page: Page, latestDocumentResponse: () => HTTPResponse | null, loaded: HTTPResponse, options: { dismissed: boolean; settleMs: number; signal?: AbortSignal }): Promise<HTTPResponse | undefined> {
	const { dismissed, settleMs, signal } = options;
	let shown = false;
	if (!dismissed) {
		const state = await readPageState(page);
		if (state?.bypass || state?.captchaState === "solved") return undefined;
		// A challenge only its header names cannot clear in the DOM; one the DOM shows can.
		shown = shownChallenge(state) !== undefined;
		if (!shown && !headerChallenge(loaded)) return undefined;
	}
	const deadline = Date.now() + settleMs;
	while (Date.now() < deadline && !signal?.aborted) {
		await sleep(WEBSITE_INTERSTITIAL_POLL_MS, signal);
		if (signal?.aborted) return undefined;
		const response = latestDocumentResponse();
		if (response && response !== loaded) {
			if (await isParsed(page, response)) return response;
			// Arriving, not yet parsed: the interstitial is gone already.
			continue;
		}
		if (dismissed) continue;
		const state = await readPageState(page);
		if (state?.captchaState === "failed" || (shown && state && !shownChallenge(state))) return undefined;
	}
	return undefined;
}

/**
 * Why the page a route ended on is not the site but the network being
 * turned away, or undefined when it is the site: a bot check still standing
 * (in the page, or named by the headers of the document it ended on), a
 * WAF's block page, or a bare gateway or server error. A page of the site
 * under any status, a bare "Not Found" too, is the site.
 */
export async function turnedAway(page: Page, response: HTTPResponse | null): Promise<string | undefined> {
	const state = await readPageState(page);
	if (!state) return undefined;
	const title = squash(state.title);
	const named = `${response ? `HTTP ${response.status()}` : "the page"}${title ? ` ("${title}")` : ""}`;
	const challenge = shownChallenge(state) ?? (response && state.captchaState !== "solved" && !state.bypass ? headerChallenge(response) : undefined);
	if (challenge) return `${named}, a ${challenge} challenge that did not pass`;
	const bare = classifyBareErrorPage({ title: state.title, text: state.text, html: state.html, ...(response ? { headers: response.headers() } : {}) });
	if (bare === "blocked") return `${named}, a page blocking this network`;
	if (bare === "server_error") return `${named}, a bare server error`;
	return undefined;
}
