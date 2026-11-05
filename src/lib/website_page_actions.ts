import type { ElementHandle, Frame, Page } from "rebrowser-puppeteer-core";

import { sleep } from "./utils";
import { CONTINUATION_CONTROL_SELECTOR } from "./website_fields";
import { describePageAction, type WebsiteDataEntryField, type WebsiteHumanCheck, type WebsitePageAction, type WebsitePerformedAction } from "./website_types";

/** How long the action's target may take to appear, for example after an earlier step re-renders the page. */
const TARGET_APPEAR_MS = 10_000;
/** How long a captcha widget beside a field may take to issue its token. */
const HUMAN_CHECK_MS = 30_000;
const POLL_MS = 250;
const clickDelay = () => 60 + Math.round(Math.random() * 80);

/** Hidden inputs a captcha widget fills with its token once the visitor passes it. */
const HUMAN_CHECK_TOKEN_SELECTOR = "[name=cf-turnstile-response], [name=g-recaptcha-response], [name=h-captcha-response]";
const HUMAN_CHECK_WIDGET_SELECTOR = `.cf-turnstile, .g-recaptcha, .h-captcha, ${HUMAN_CHECK_TOKEN_SELECTOR}`;

/** The live page showed no field or button matching the one the classifier named. */
export class WebsitePageActionTargetMissingError extends Error {
	constructor(readonly action: WebsitePageAction) {
		super(`the page showed no ${describePageAction(action).replace(/^the /, "")} to ${action.kind === "fill" ? "enter the value into" : "click"}`);
		this.name = "WebsitePageActionTargetMissingError";
	}
}

/** A CSS string literal; ids and names from a kit can hold any character. */
function cssString(value: string): string {
	return `"${value.replace(/["\\]/g, (character) => `\\${character}`).replace(/\n/g, "\\a ")}"`;
}

/**
 * Selector for the field on the live page, from the attributes the captured
 * document recorded for it. A field with neither id nor name cannot be found
 * again reliably and is never named for submission.
 */
export function liveFieldSelector(field: WebsiteDataEntryField): string | undefined {
	const tag = field.control.match(/^[a-z]+/i)?.[0] ?? "input";
	if (field.id) return `${tag}[id=${cssString(field.id)}]`;
	if (field.name) return `${tag}[name=${cssString(field.name)}]`;
	return undefined;
}

/** Runs in the page: the element is drawn where a visitor can see and reach it. */
function isShown(element: Element): boolean {
	const box = element.getBoundingClientRect();
	const style = getComputedStyle(element);
	return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

/**
 * Runs in the page: the first shown control whose caption is `label`, read as
 * website_fields.ts `controlCaption` reads it from the captured document.
 * Kits randomize ids and classes per visit; the caption is what stays.
 */
function controlCaptioned(selector: string, label: string): Element | null {
	const descriptor = (value: string | null | undefined) => {
		const compact = value?.replace(/\s+/g, " ").trim();
		return compact ? compact.slice(0, 120) : undefined;
	};
	return [...document.querySelectorAll(selector)].find((element) => {
		const value = element.tagName.toLowerCase() === "input" ? element.getAttribute("value") : undefined;
		const caption = descriptor(element.textContent) ?? descriptor(value) ?? descriptor(element.getAttribute("aria-label")) ?? descriptor(element.getAttribute("title"));
		if (caption !== label || element.hasAttribute("disabled")) return false;
		const box = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
	}) ?? null;
}

/** The action's field or button, shown in any frame of the page; waits up to `waitMs` for it to appear. */
async function findTarget(page: Page, action: WebsitePageAction, waitMs: number): Promise<{ frame: Frame; target: ElementHandle<Element> } | undefined> {
	const selector = action.kind === "fill" ? liveFieldSelector(action.field) : undefined;
	if (action.kind === "fill" && !selector) return undefined;
	const deadline = Date.now() + waitMs;
	do {
		for (const frame of page.frames()) {
			if (frame.detached) continue;
			if (action.kind === "fill") {
				for (const field of await frame.$$(selector!).catch(() => [])) {
					if (await field.evaluate(isShown).catch(() => false)) return { frame, target: field };
					await field.dispose().catch(() => undefined);
				}
			} else {
				const handle = await frame.evaluateHandle(controlCaptioned, CONTINUATION_CONTROL_SELECTOR, action.control.label).catch(() => undefined);
				const control = handle?.asElement() as ElementHandle<Element> | null | undefined;
				if (control) return { frame, target: control };
				await handle?.dispose().catch(() => undefined);
			}
		}
		if (Date.now() >= deadline) break;
		await sleep(POLL_MS);
	} while (Date.now() < deadline);
	return undefined;
}

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
async function waitForHumanCheck(page: Page, frame: Frame, options: HumanCheckOptions): Promise<WebsiteHumanCheck | undefined> {
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

/**
 * The control a visitor clicks to send the field: its form's own submit
 * button, or for a kit that draws its form without one, the first shown
 * button after the field. Undefined when Enter in the field is all there is.
 */
async function submitControl(field: ElementHandle<Element>): Promise<ElementHandle<Element> | undefined> {
	const handle = await field.evaluateHandle((element, controlSelector: string) => {
		const shown = (candidate: Element) => {
			const box = candidate.getBoundingClientRect();
			const style = getComputedStyle(candidate);
			return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none";
		};
		const form = (element as HTMLInputElement).form;
		const inForm = form ? [...form.querySelectorAll("button:not([type]), button[type=submit], input[type=submit], input[type=image]")].find(shown) : undefined;
		if (inForm) return inForm;
		const after = [...document.querySelectorAll(controlSelector)]
			.find((candidate) => shown(candidate) && (element.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
		return after ?? null;
	}, CONTINUATION_CONTROL_SELECTOR);
	const control = handle.asElement() as ElementHandle<Element> | null;
	if (!control) await handle.dispose();
	return control ?? undefined;
}

/**
 * Take one step on the live page as a visitor would. A fill enters the
 * canary into the named field, waits for a captcha widget beside it to pass,
 * and sends it with the form's own button (or Enter); only that field is
 * filled, so a kit's hidden honeypot fields stay empty. A click presses the
 * named button.
 */
export async function performPageAction(page: Page, action: WebsitePageAction, humanCheck: HumanCheckOptions = {}): Promise<WebsitePerformedAction> {
	const found = await findTarget(page, action, TARGET_APPEAR_MS);
	if (!found) throw new WebsitePageActionTargetMissingError(action);
	const { frame, target } = found;
	try {
		if (action.kind === "click") {
			await target.click({ delay: clickDelay() });
			return action;
		}
		await target.click({ delay: 40 + Math.round(Math.random() * 60) });
		await target.evaluate((element) => {
			if ("value" in element) (element as HTMLInputElement).value = "";
		});
		await target.type(action.value, { delay: 25 + Math.round(Math.random() * 40) });
		const check = await waitForHumanCheck(page, frame, humanCheck);
		const control = await submitControl(target);
		if (control) {
			await control.click({ delay: clickDelay() }).finally(() => control.dispose().catch(() => undefined));
		} else {
			await target.press("Enter");
		}
		return { ...action, ...(check ? { humanCheck: check } : {}) };
	} finally {
		await target.dispose().catch(() => undefined);
	}
}
