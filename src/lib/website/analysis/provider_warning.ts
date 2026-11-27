import type { Page } from "rebrowser-puppeteer-core";

import { waitForCaptchaOutcome } from "../../browser/captcha_state";
import type { WebsiteProviderWarning } from "../types";

/**
 * Cloudflare's own warning before a site it suspects ("Suspected Phishing",
 * "Suspected Malware") answers 403 with a form to `/cdn-cgi/phish-bypass`,
 * whose "Ignore & Proceed" button unlocks once its Turnstile passes. It is
 * not the site: a visitor who proceeds sees the site, so the capture does.
 */
export const CLOUDFLARE_BYPASS_FORM = "form[action$='/cdn-cgi/phish-bypass']";
/** How long the button may stay locked: Browser Fabric's solver passes the Turnstile in about 10 s, slower over Tor. */
const BUTTON_UNLOCK_MS = 60_000;

/** Runs in the page: the warning its bypass form stands under, named by its title ("Suspected Malware | Cloudflare"). Exported so a fake page can answer it. */
export function providerWarningProbe(selector: string): string | undefined {
	if (!document.querySelector(selector)) return undefined;
	return document.title.match(/^(.+?)\s*\|\s*Cloudflare/i)?.[1] ?? document.body.innerText.match(/Suspected [A-Z][a-z]+/)?.[0] ?? "Suspected Phishing";
}

/**
 * Dismiss a provider's warning page as a visitor would; undefined when the
 * page is none. Its Turnstile is passed by the browser's own solver (or by
 * itself); the wait is for what that unlocks, the button. A solver that gives
 * up, or a button still locked at the bound, leaves the warning to be
 * captured as the page.
 */
export async function passProviderWarning(page: Page): Promise<WebsiteProviderWarning | undefined> {
	const warning = await page.evaluate(providerWarningProbe, CLOUDFLARE_BYPASS_FORM).catch(() => undefined);
	if (typeof warning !== "string" || !warning) return undefined;
	const button = `${CLOUDFLARE_BYPASS_FORM} [type=submit]`;
	const unlocked = () => page.$eval(button, (element) => !(element as HTMLButtonElement).disabled).catch(() => false);
	if (!(await waitForCaptchaOutcome(page, unlocked, { label: "The warning's Turnstile", timeoutMs: BUTTON_UNLOCK_MS }).then(() => true, () => false))) return undefined;
	await page.click(button, { delay: 60 + Math.round(Math.random() * 80) });
	return { provider: "Cloudflare", warning };
}
