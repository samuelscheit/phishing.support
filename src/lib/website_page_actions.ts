import type { ElementHandle, Frame, Page } from "rebrowser-puppeteer-core";

import { sleep } from "./utils";
import { CONTINUATION_CONTROL_SELECTOR } from "./website_fields";
import { describePageAction, type WebsiteDataEntryField, type WebsitePageAction, type WebsitePerformedAction } from "./website_types";

/** How long the action's target may take to appear, for example after an earlier step re-renders the page. */
const TARGET_APPEAR_MS = 10_000;
/** How long a captcha widget beside a field may take to issue its token. */
const HUMAN_CHECK_MS = 30_000;
const POLL_MS = 250;

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

/** Whether the action's target is on the page right now, without waiting for it. */
export async function pageShowsActionTarget(page: Page, action: WebsitePageAction): Promise<boolean> {
	const found = await findTarget(page, action, 0);
	await found?.target.dispose().catch(() => undefined);
	return found !== undefined;
}

/** Whether the field's frame has a captcha widget and, once it does, whether that widget issued its token. */
async function waitForHumanCheck(frame: Frame, humanCheckMs: number): Promise<"passed" | "unsolved" | undefined> {
	const hasWidget = await frame.$(HUMAN_CHECK_WIDGET_SELECTOR).then((widget) => widget !== null).catch(() => false);
	if (!hasWidget) return undefined;
	const deadline = Date.now() + humanCheckMs;
	while (Date.now() < deadline) {
		const token = await frame.evaluate(
			(selector: string) => [...document.querySelectorAll<HTMLInputElement>(selector)].some((input) => input.value.trim().length > 0),
			HUMAN_CHECK_TOKEN_SELECTOR,
		).catch(() => false);
		if (token) return "passed";
		await sleep(POLL_MS);
	}
	return "unsolved";
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

const clickDelay = () => 60 + Math.round(Math.random() * 80);

/**
 * Take one step on the live page as a visitor would. A fill enters the
 * canary into the named field, waits for a captcha widget beside it to pass,
 * and sends it with the form's own button (or Enter); only that field is
 * filled, so a kit's hidden honeypot fields stay empty. A click presses the
 * named button.
 */
export async function performPageAction(page: Page, action: WebsitePageAction, humanCheckMs = HUMAN_CHECK_MS): Promise<WebsitePerformedAction> {
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
		const humanCheck = await waitForHumanCheck(frame, humanCheckMs);
		const control = await submitControl(target);
		if (control) {
			await control.click({ delay: clickDelay() }).finally(() => control.dispose().catch(() => undefined));
		} else {
			await target.press("Enter");
		}
		return { ...action, ...(humanCheck ? { humanCheck } : {}) };
	} finally {
		await target.dispose().catch(() => undefined);
	}
}
