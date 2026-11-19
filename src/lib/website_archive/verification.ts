import { type Frame, type Page } from "rebrowser-puppeteer-core";

import { CAPTCHA_PROVIDER_FRAME } from "../human_check";
import { sleep } from "../sleep";
import { WEBSITE_RENDER_IDLE_MS, settleRendering } from "./settle";
import type { WebsiteVerificationGate } from "./types";

/** How often a clicked verification gate is checked for the page it reveals. */
const WEBSITE_GATE_POLL_MS = 250;

/** Marks the one gate control found, so it can be located again to click. */
const GATE_ATTRIBUTE = "data-phishing-support-gate";
/**
 * Controls a visitor types into. The input types website_fields.ts does not
 * count as data entry are left out: a site's search box (Google Sites shows
 * one on every page) is not a kit's form.
 */
const DATA_ENTRY_SELECTOR = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=search]):not([type=range]):not([type=color]), textarea, select";
type FrameGateScan = { fields: boolean; controls: number; label: string | null };

/**
 * Looks for a kit's own human-verification gate in one frame's document: a
 * single clickable "I'm not a robot"/"verify you are human" control, with no
 * data-entry field beside it. Real captcha widgets live in their provider's
 * frame, which is never scanned. A lone control is marked so it can be clicked.
 * Runs in the page, so it must not reference anything outside itself.
 */
function scanVerificationGate(dataEntrySelector: string): FrameGateScan {
	const caption = /\b(?:i['’`]?\s*a?m\s+not\s+a\s+robot|verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human|(?:confirm|prove)\s+(?:that\s+)?you(?:['’`]re|\s+are)\s+(?:a\s+)?human)\b/i;
	const visible = (element: Element) => {
		const box = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.1;
	};
	if ([...document.querySelectorAll(dataEntrySelector)].some(visible)) return { fields: true, controls: 0, label: null };
	// A kit often draws its checkbox as a bare <div> whose script listens for the
	// click (x-com.email's fake Turnstile); the hand cursor it styles is the only
	// mark it carries. The cursor is inherited, so the element that sets it is the
	// one the listener sits on. Links lead elsewhere and are no gate.
	const setsPointer = (element: Element) => !element.matches("a[href], area[href]")
		&& getComputedStyle(element).cursor === "pointer"
		&& (!element.parentElement || getComputedStyle(element.parentElement).cursor !== "pointer");
	const clickable = [...new Set([
		...document.querySelectorAll("[role=button], [role=checkbox], button, input[type=checkbox], label, [tabindex]"),
		...[...document.querySelectorAll("body *")].filter(setsPointer),
	])].filter(visible);
	// A control's caption is its own text or, for an empty checkbox drawn next
	// to its caption, the text of the nearest widget around it that holds no
	// other control.
	const captionOf = (control: Element): string | null => {
		let node: Element | null = control;
		for (let depth = 0; node && depth <= 3; node = node.parentElement, depth++) {
			if (depth > 0 && clickable.some((other) => other !== control && node!.contains(other) && !control.contains(other) && !other.contains(control))) return null;
			const found = caption.exec(`${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`);
			if (found) return found[0];
		}
		return null;
	};
	const candidates = clickable.flatMap((element) => {
		const text = captionOf(element);
		return text === null ? [] : [{ element, text }];
	});
	// The innermost control carrying the caption is the one a visitor clicks.
	const controls = candidates.filter(({ element }) => !candidates.some((other) => other.element !== element && element.contains(other.element)));
	if (controls.length !== 1) return { fields: false, controls: controls.length, label: null };
	const [{ element: control, text }] = controls as [{ element: Element; text: string }];
	// Same value as GATE_ATTRIBUTE; this function runs in the page, not here.
	control.setAttribute("data-phishing-support-gate", "");
	const label = text.replace(/\s+/g, " ").trim();
	return { fields: false, controls: 1, label: label.slice(0, 120) || "verification gate" };
}


/** Whether a frame is drawn on the page: every frame element up to the top document has a visible box. */
async function frameIsVisible(frame: Frame): Promise<boolean> {
	for (let current = frame; current.parentFrame(); current = current.parentFrame()!) {
		const element = await current.frameElement().catch(() => null);
		const box = await element?.boundingBox().catch(() => null);
		await element?.dispose().catch(() => undefined);
		if (!box || box.width <= 4 || box.height <= 4) return false;
	}
	return true;
}

/**
 * Clicks through a kit's fake verification gate, like a visitor would, and
 * waits for the page it reveals. The gate may sit in any visible frame: Google
 * Sites shows an embedded Apps Script page two sandbox frames deep. Across all
 * of them there must be exactly one gate control and no data-entry field.
 * Returns the gate when one was clicked.
 */
export async function passVerificationGate(page: Page, settleMs: number): Promise<WebsiteVerificationGate | undefined> {
	const scans: Array<{ frame: Frame; scan: FrameGateScan }> = [];
	for (const frame of page.frames()) {
		if (frame.detached || CAPTCHA_PROVIDER_FRAME.test(frame.url()) || !await frameIsVisible(frame)) continue;
		const scan = await frame.evaluate(scanVerificationGate, DATA_ENTRY_SELECTOR).catch(() => null);
		if (scan) scans.push({ frame, scan });
	}
	const gate = scans.find(({ scan }) => scan.label);
	try {
		if (!gate || scans.some(({ scan }) => scan.fields) || scans.reduce((total, { scan }) => total + scan.controls, 0) !== 1) return undefined;
		const control = await gate.frame.$(`[${GATE_ATTRIBUTE}]`);
		if (!control) return undefined;
		try {
			await control.click({ delay: 60 + Math.round(Math.random() * 80) });
			// Gates verify against their own backend first (a proof of work, a
			// warm-up call), then swap in or navigate their frame to the real page.
			// Neither the gate leaving nor a quiet network says that page is there:
			// the proof of work is silent and runs on behind a "Verifying" spinner.
			await waitForRevealedForm(page, settleMs);
			await settleRendering(page, settleMs);
		} finally {
			await control.dispose().catch(() => undefined);
		}
		return { label: gate.scan.label! };
	} finally {
		for (const { frame } of scans) {
			await frame.evaluate((attribute: string) => document.querySelector(`[${attribute}]`)?.removeAttribute(attribute), GATE_ATTRIBUTE).catch(() => undefined);
		}
	}
}

/** Whether a frame's document shows a field a visitor can type into. */
function showsDataEntryField(dataEntrySelector: string): boolean {
	return [...document.querySelectorAll(dataEntrySelector)].some((element) => {
		const box = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return box.width > 4 && box.height > 4 && style.visibility !== "hidden" && style.display !== "none";
	});
}

/**
 * Waits until a frame on the page shows the form the gate revealed, through
 * any navigation of the gate's frame, then for that form's own requests. Past
 * the bound the page is captured as it stands.
 */
async function waitForRevealedForm(page: Page, settleMs: number): Promise<void> {
	const deadline = Date.now() + settleMs;
	while (Date.now() < deadline) {
		await sleep(WEBSITE_GATE_POLL_MS);
		let revealed = false;
		for (const frame of page.frames()) {
			// A frame mid-navigation has no document to ask yet.
			if (!frame.detached && await frame.evaluate(showsDataEntryField, DATA_ENTRY_SELECTOR).catch(() => false) && await frameIsVisible(frame)) revealed = true;
		}
		if (revealed) break;
	}
	await settleRendering(page, Math.max(WEBSITE_RENDER_IDLE_MS, deadline - Date.now()));
}

