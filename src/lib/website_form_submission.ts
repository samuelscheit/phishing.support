import type { ElementHandle, Frame, Page } from "rebrowser-puppeteer-core";

import { sleep } from "./utils";
import { describeDataEntryField, type WebsiteFieldSubmission, type WebsiteSubmittedField } from "./website_types";

/** How long the named field may take to appear, for example after an earlier submission re-renders the page. */
const FIELD_APPEAR_MS = 10_000;
/** How long a captcha widget beside the field may take to issue its token. */
const HUMAN_CHECK_MS = 30_000;
const POLL_MS = 250;

/** Hidden inputs a captcha widget fills with its token once the visitor passes it. */
const HUMAN_CHECK_TOKEN_SELECTOR = "[name=cf-turnstile-response], [name=g-recaptcha-response], [name=h-captcha-response]";
const HUMAN_CHECK_WIDGET_SELECTOR = `.cf-turnstile, .g-recaptcha, .h-captcha, ${HUMAN_CHECK_TOKEN_SELECTOR}`;

/** The live page showed no field matching the one the classifier named. */
export class WebsiteFieldMissingError extends Error {
	constructor(readonly label: string) {
		super(`the page showed no field ${JSON.stringify(label)} to enter the address into`);
		this.name = "WebsiteFieldMissingError";
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
export function liveFieldSelector(field: WebsiteFieldSubmission["field"]): string | undefined {
	const tag = field.control.match(/^[a-z]+/i)?.[0] ?? "input";
	if (field.id) return `${tag}[id=${cssString(field.id)}]`;
	if (field.name) return `${tag}[name=${cssString(field.name)}]`;
	return undefined;
}

function isShown(element: Element): boolean {
	const box = element.getBoundingClientRect();
	const style = getComputedStyle(element);
	return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

async function findShownField(page: Page, selector: string): Promise<{ frame: Frame; field: ElementHandle<Element> } | undefined> {
	const deadline = Date.now() + FIELD_APPEAR_MS;
	do {
		for (const frame of page.frames()) {
			if (frame.detached) continue;
			for (const field of await frame.$$(selector).catch(() => [])) {
				if (await field.evaluate(isShown).catch(() => false)) return { frame, field };
				await field.dispose().catch(() => undefined);
			}
		}
		await sleep(POLL_MS);
	} while (Date.now() < deadline);
	return undefined;
}

/** Whether the field's frame has a captcha widget and, once it does, whether that widget issued its token. */
async function waitForHumanCheck(frame: Frame, humanCheckMs: number): Promise<WebsiteSubmittedField["humanCheck"]> {
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
	const handle = await field.evaluateHandle((element) => {
		const shown = (candidate: Element) => {
			const box = candidate.getBoundingClientRect();
			const style = getComputedStyle(candidate);
			return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none";
		};
		const form = (element as HTMLInputElement).form;
		const inForm = form ? [...form.querySelectorAll("button:not([type]), button[type=submit], input[type=submit], input[type=image]")].find(shown) : undefined;
		if (inForm) return inForm;
		const after = [...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]")]
			.find((candidate) => shown(candidate) && (element.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
		return after ?? null;
	});
	const control = handle.asElement() as ElementHandle<Element> | null;
	if (!control) await handle.dispose();
	return control ?? undefined;
}

/**
 * Enter the canary into the named field, as a visitor types their address,
 * wait for a captcha widget beside it to pass, and send it with the form's
 * own button (or Enter). Only this field is filled: a kit's hidden honeypot
 * fields stay empty, as a visitor leaves them.
 */
export async function submitWebsiteField(page: Page, submission: WebsiteFieldSubmission, humanCheckMs = HUMAN_CHECK_MS): Promise<WebsiteSubmittedField> {
	const label = describeDataEntryField(submission.field);
	const selector = liveFieldSelector(submission.field);
	const found = selector ? await findShownField(page, selector) : undefined;
	if (!found) throw new WebsiteFieldMissingError(label);
	const { frame, field } = found;
	try {
		await field.click({ delay: 40 + Math.round(Math.random() * 60) });
		await field.evaluate((element) => {
			if ("value" in element) (element as HTMLInputElement).value = "";
		});
		await field.type(submission.value, { delay: 25 + Math.round(Math.random() * 40) });
		const humanCheck = await waitForHumanCheck(frame, humanCheckMs);
		const control = await submitControl(field);
		if (control) {
			await control.click({ delay: 60 + Math.round(Math.random() * 80) }).finally(() => control.dispose().catch(() => undefined));
		} else {
			await field.press("Enter");
		}
		return { ...submission, ...(humanCheck ? { humanCheck } : {}) };
	} finally {
		await field.dispose().catch(() => undefined);
	}
}
