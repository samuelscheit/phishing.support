import type { Page } from "rebrowser-puppeteer-core";

import { sleep } from "../sleep";
import { waitForHumanCheck, type HumanCheckOptions } from "../human_check";
import type { WebsiteProviderWarning } from "./types";

/**
 * Cloudflare's own warning before a site it suspects ("Suspected Phishing",
 * "Suspected Malware") answers 403 with a form to `/cdn-cgi/phish-bypass`,
 * whose "Ignore & Proceed" button unlocks once its Turnstile passes. It is
 * not the site: a visitor who proceeds sees the site, so the capture does.
 */
const CLOUDFLARE_BYPASS_FORM = "form[action$='/cdn-cgi/phish-bypass']";
const BUTTON_ENABLED_MS = 5_000;
const POLL_MS = 250;

/** Dismiss a provider's warning page as a visitor would; undefined when the page is none. */
export async function passProviderWarning(page: Page, options: HumanCheckOptions = {}): Promise<WebsiteProviderWarning | undefined> {
	// Its title names the warning: "Suspected Malware | Cloudflare".
	const warning = await page.evaluate((selector) => {
		if (!document.querySelector(selector)) return undefined;
		return document.title.match(/^(.+?)\s*\|\s*Cloudflare/i)?.[1] ?? document.body.innerText.match(/Suspected [A-Z][a-z]+/)?.[0] ?? "Suspected Phishing";
	}, CLOUDFLARE_BYPASS_FORM).catch(() => undefined);
	if (typeof warning !== "string" || !warning) return undefined;
	await waitForHumanCheck(page, page.mainFrame(), options);
	const button = `${CLOUDFLARE_BYPASS_FORM} [type=submit]`;
	const deadline = Date.now() + BUTTON_ENABLED_MS;
	while (Date.now() < deadline && await page.$eval(button, (element) => (element as HTMLButtonElement).disabled).catch(() => true)) await sleep(POLL_MS);
	if (await page.$eval(button, (element) => (element as HTMLButtonElement).disabled).catch(() => true)) return undefined;
	await page.click(button, { delay: 60 + Math.round(Math.random() * 80) });
	return { provider: "Cloudflare", warning };
}
