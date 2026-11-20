import type { Page } from "rebrowser-puppeteer-core";

import { sleep } from "../../util/sleep";
import { waitForCaptchaSolved } from "../../browser/captcha_state";
import type { WebsiteProviderWarning } from "../types";

/**
 * Cloudflare's own warning before a site it suspects ("Suspected Phishing",
 * "Suspected Malware") answers 403 with a form to `/cdn-cgi/phish-bypass`,
 * whose "Ignore & Proceed" button unlocks once its Turnstile passes. It is
 * not the site: a visitor who proceeds sees the site, so the capture does.
 */
const CLOUDFLARE_BYPASS_FORM = "form[action$='/cdn-cgi/phish-bypass']";
const BUTTON_ENABLED_MS = 5_000;
const POLL_MS = 250;
/** How long the warning's Turnstile may take to show the solver's state; one that passes invisibly shows none. */
const CAPTCHA_GRACE_MS = 5_000;
/** How long Browser Fabric's solver may work on that Turnstile (it passes in about 10 s). */
const CAPTCHA_TIMEOUT_MS = 60_000;

/**
 * Dismiss a provider's warning page as a visitor would; undefined when the
 * page is none. Its Turnstile is passed by the browser's own solver, which
 * is waited for; one it gives up on leaves the button locked, and the
 * warning is then captured as the page.
 */
export async function passProviderWarning(page: Page, options: { captchaGraceMs?: number } = {}): Promise<WebsiteProviderWarning | undefined> {
	// Its title names the warning: "Suspected Malware | Cloudflare".
	const warning = await page.evaluate((selector) => {
		if (!document.querySelector(selector)) return undefined;
		return document.title.match(/^(.+?)\s*\|\s*Cloudflare/i)?.[1] ?? document.body.innerText.match(/Suspected [A-Z][a-z]+/)?.[0] ?? "Suspected Phishing";
	}, CLOUDFLARE_BYPASS_FORM).catch(() => undefined);
	if (typeof warning !== "string" || !warning) return undefined;
	await waitForCaptchaSolved(page, { label: "The warning's Turnstile", graceMs: options.captchaGraceMs ?? CAPTCHA_GRACE_MS, timeoutMs: CAPTCHA_TIMEOUT_MS }).catch(() => false);
	const button = `${CLOUDFLARE_BYPASS_FORM} [type=submit]`;
	const deadline = Date.now() + BUTTON_ENABLED_MS;
	while (Date.now() < deadline && await page.$eval(button, (element) => (element as HTMLButtonElement).disabled).catch(() => true)) await sleep(POLL_MS);
	if (await page.$eval(button, (element) => (element as HTMLButtonElement).disabled).catch(() => true)) return undefined;
	await page.click(button, { delay: 60 + Math.round(Math.random() * 80) });
	return { provider: "Cloudflare", warning };
}
