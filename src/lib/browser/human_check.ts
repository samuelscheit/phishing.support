import type { Frame, Page } from "rebrowser-puppeteer-core";

import { sleep } from "../util/sleep";

/**
 * Captcha widgets of real providers (reCAPTCHA, hCaptcha, Turnstile) beside a
 * control the capture must press: waited for, and their checkbox clicked once
 * as a visitor would. An image challenge is never attempted.
 */

/** How long a captcha widget beside a field may take to issue its token. */
const HUMAN_CHECK_MS = 30_000;
const POLL_MS = 250;
const clickDelay = () => 60 + Math.round(Math.random() * 80);

/** Hidden inputs a captcha widget fills with its token once the visitor passes it. */
const HUMAN_CHECK_TOKEN_SELECTOR = "[name=cf-turnstile-response], [name=g-recaptcha-response], [name=h-captcha-response]";
const HUMAN_CHECK_WIDGET_SELECTOR = `.cf-turnstile, .g-recaptcha, .h-captcha, ${HUMAN_CHECK_TOKEN_SELECTOR}`;

/**
 * Frames of real captcha services: Google reCAPTCHA, hCaptcha, and Cloudflare
 * Turnstile. Their checkbox is a real challenge, never a kit's own gate.
 */
export const CAPTCHA_PROVIDER_FRAME = /^https:\/\/(?:www\.)?(?:google\.com\/recaptcha\/|recaptcha\.net\/|[\w-]+\.hcaptcha\.com\/|hcaptcha\.com\/|challenges\.cloudflare\.com\/)/i;
/** How long a widget may pass invisibly before the capture clicks its checkbox, as a visitor would; at most a third of the overall bound. */
const HUMAN_CHECK_INVISIBLE_MS = 5_000;
/**
 * Where a visitor clicks the checkbox in a provider's widget frame, from its
 * left edge: Turnstile, reCAPTCHA, and hCaptcha all draw it about 30 px in,
 * centred vertically. Turnstile draws it inside closed shadow roots, so the
 * frame's position is the only reliable handle.
 */
const HUMAN_CHECK_CHECKBOX_X = 30;

/** How the widget went: it passed by itself, after its checkbox was clicked, or never. */
export type HumanCheck = "passed" | "passed_after_click" | "unsolved" | "unsolved_after_click";

export type HumanCheckOptions = {
	/** The overall bound on the widget issuing its token. */
	humanCheckMs?: number;
	/** Which frames are a captcha provider's widget; a test seam. */
	captchaProviderFrame?: RegExp;
};

async function hasToken(frame: Frame): Promise<boolean> {
	return frame.evaluate(
		(selector: string) => [...document.querySelectorAll<HTMLInputElement>(selector)].some((input) => input.value.trim().length > 0),
		HUMAN_CHECK_TOKEN_SELECTOR,
	).catch(() => false);
}

/** Clicks the checkbox of the provider widget drawn in the field's frame, once; false when no widget frame is shown. */
async function clickHumanCheckCheckbox(page: Page, frame: Frame, providerFrame: RegExp): Promise<boolean> {
	for (const widget of frame.childFrames()) {
		if (widget.detached || !providerFrame.test(widget.url())) continue;
		const element = await widget.frameElement().catch(() => null);
		const box = await element?.boundingBox().catch(() => null);
		await element?.dispose().catch(() => undefined);
		if (!box || box.width < 50 || box.height < 20) continue;
		const x = box.x + Math.min(HUMAN_CHECK_CHECKBOX_X, box.width / 2);
		const y = box.y + box.height / 2;
		await page.mouse.move(x - 40 + Math.random() * 10, y - 15 + Math.random() * 10);
		await page.mouse.move(x, y, { steps: 8 });
		await page.mouse.click(x, y, { delay: clickDelay() });
		return true;
	}
	return false;
}

/**
 * Whether the field's frame has a captcha widget and, once it does, whether
 * that widget issued its token. A widget that does not pass invisibly within
 * a few seconds gets one click on its checkbox, as a visitor would; an image
 * challenge it may show then is never attempted.
 */
export async function waitForHumanCheck(page: Page, frame: Frame, options: HumanCheckOptions): Promise<HumanCheck | undefined> {
	const hasWidget = await frame.$(HUMAN_CHECK_WIDGET_SELECTOR).then((widget) => widget !== null).catch(() => false);
	if (!hasWidget) return undefined;
	const boundMs = options.humanCheckMs ?? HUMAN_CHECK_MS;
	const deadline = Date.now() + boundMs;
	const clickAt = Date.now() + Math.min(HUMAN_CHECK_INVISIBLE_MS, boundMs / 3);
	let clicked = false;
	while (Date.now() < deadline) {
		if (await hasToken(frame)) return clicked ? "passed_after_click" : "passed";
		if (!clicked && Date.now() >= clickAt) clicked = await clickHumanCheckCheckbox(page, frame, options.captchaProviderFrame ?? CAPTCHA_PROVIDER_FRAME);
		await sleep(POLL_MS);
	}
	return clicked ? "unsolved_after_click" : "unsolved";
}

