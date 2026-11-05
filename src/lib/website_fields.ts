import { parse, type HTMLElement } from "node-html-parser";

import type { WebsiteContinuationControl, WebsiteContinuationLink, WebsiteDataEntryField } from "./website_types";
import { isSameWebsite } from "./website_site";

/** Input types that trigger an action, pick from fixed choices, or declare a site search box. */
const NON_DATA_ENTRY_INPUT_TYPES = new Set(["button", "checkbox", "color", "hidden", "image", "radio", "range", "reset", "search", "submit"]);
const EDITABLE_CONTENT_VALUES = new Set(["", "true", "plaintext-only"]);
const CANDIDATE_CONTROLS = "input, textarea, select, [contenteditable]";
const MAX_DATA_ENTRY_FIELDS = 50;
const MAX_DESCRIPTOR_LENGTH = 120;

function descriptor(value: string | undefined): string | undefined {
	const compact = value?.replace(/\s+/g, " ").trim();
	return compact ? compact.slice(0, MAX_DESCRIPTOR_LENGTH) : undefined;
}

function dataEntryControl(element: HTMLElement): string | undefined {
	if (element.hasAttribute("disabled")) return undefined;
	const tag = element.tagName.toLowerCase();
	if (tag === "input") {
		const type = element.getAttribute("type")?.trim().toLowerCase() || "text";
		return NON_DATA_ENTRY_INPUT_TYPES.has(type) || element.hasAttribute("readonly") ? undefined : `input[type=${type}]`;
	}
	if (tag === "textarea") return element.hasAttribute("readonly") ? undefined : "textarea";
	if (tag === "select") return "select";
	const editable = element.getAttribute("contenteditable")?.trim().toLowerCase();
	return editable !== undefined && EDITABLE_CONTENT_VALUES.has(editable) ? `${tag}[contenteditable]` : undefined;
}

function fieldLabel(root: HTMLElement, element: HTMLElement, labelsByFor: Map<string, string>): string | undefined {
	const labelledBy = element
		.getAttribute("aria-labelledby")
		?.split(/\s+/)
		.map((id) => (id ? root.getElementById(id)?.textContent : undefined))
		.join(" ");
	const id = element.getAttribute("id");
	const previous = element.previousElementSibling;
	// Phishing kits often place an unassociated <label> directly before its input.
	const precedingLabel = previous?.tagName === "LABEL" && !previous.hasAttribute("for") && !previous.querySelector(CANDIDATE_CONTROLS)
		? previous.textContent
		: undefined;
	return descriptor(labelledBy)
		?? descriptor(element.getAttribute("aria-label"))
		?? descriptor(id ? labelsByFor.get(id) : undefined)
		?? descriptor(element.closest("label")?.textContent)
		?? descriptor(element.getAttribute("title"))
		?? descriptor(precedingLabel);
}

/**
 * Lists every control in a captured document through which a visitor can
 * enter data. Phishing kits often render their inputs in script-driven
 * dialogs without a `<form>`, and their labels can be in any language, so a
 * field is recognized only from language-neutral markup and described with
 * its own label text. References are assigned in document order, so the same
 * capture always yields the same references.
 */
export function extractWebsiteDataEntryFields(html: string): WebsiteDataEntryField[] {
	const root = parse(html);
	const labelsByFor = new Map<string, string>();
	for (const label of root.querySelectorAll("label[for]")) {
		const target = label.getAttribute("for");
		if (target && !labelsByFor.has(target)) labelsByFor.set(target, label.textContent);
	}

	const fields: WebsiteDataEntryField[] = [];
	for (const element of root.querySelectorAll(CANDIDATE_CONTROLS)) {
		const control = dataEntryControl(element);
		if (!control) continue;
		fields.push({
			ref: `f${fields.length + 1}`,
			control,
			id: descriptor(element.getAttribute("id")),
			name: descriptor(element.getAttribute("name")),
			autocomplete: descriptor(element.getAttribute("autocomplete")),
			label: fieldLabel(root, element, labelsByFor),
			placeholder: descriptor(element.getAttribute("placeholder")) ?? descriptor(element.getAttribute("aria-placeholder")),
		});
		if (fields.length === MAX_DATA_ENTRY_FIELDS) break;
	}
	return fields;
}

const MAX_CONTINUATION_LINKS = 30;

/** The page a link opens, without the fragment that only scrolls within it. */
function pageAddress(href: string, base: string): string | undefined {
	try {
		const url = new URL(href, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function linkLabel(element: HTMLElement): string | undefined {
	return descriptor(element.textContent)
		?? descriptor(element.getAttribute("aria-label"))
		?? descriptor(element.getAttribute("title"))
		?? descriptor(element.querySelector("img[alt]")?.getAttribute("alt"))
		?? descriptor(element.getAttribute("alt"));
}

/**
 * Lists the links on a captured page that open another page of the same
 * site: the next step of a kit that spreads its flow over several pages (a
 * consent screen, then a welcome page, then the form). Links to other sites
 * and downloads are not steps of the page's own flow. References are
 * assigned in document order, one per destination.
 */
export function extractWebsiteContinuationLinks(html: string, pageUrl: string): WebsiteContinuationLink[] {
	const root = parse(html);
	const base = pageAddress(root.querySelector("base[href]")?.getAttribute("href") ?? pageUrl, pageUrl) ?? pageUrl;
	const page = pageAddress(pageUrl, pageUrl);
	const links: WebsiteContinuationLink[] = [];
	const seen = new Set<string>();
	for (const element of root.querySelectorAll("a[href], area[href]")) {
		if (element.hasAttribute("download")) continue;
		const url = pageAddress(element.getAttribute("href")!, base);
		if (!url || url === page || seen.has(url) || !isSameWebsite(url, pageUrl)) continue;
		seen.add(url);
		const label = linkLabel(element);
		links.push({ ref: `l${links.length + 1}`, ...(label ? { label } : {}), url });
		if (links.length === MAX_CONTINUATION_LINKS) break;
	}
	return links;
}

const MAX_CONTINUATION_CONTROLS = 30;
/** Elements a visitor clicks that are not links; links are listed as continuation links. */
export const CONTINUATION_CONTROL_SELECTOR = "button, [role=button], input[type=submit], input[type=button]";

/** A button's caption, as a visitor reads it: its text, or an input button's value, or its accessible name. */
export function controlCaption(element: { textContent: string | null; getAttribute(name: string): string | null | undefined; tagName: string }): string | undefined {
	const value = element.tagName.toLowerCase() === "input" ? element.getAttribute("value") ?? undefined : undefined;
	return descriptor(element.textContent ?? undefined) ?? descriptor(value) ?? descriptor(element.getAttribute("aria-label") ?? undefined) ?? descriptor(element.getAttribute("title") ?? undefined);
}

/**
 * Lists the buttons on a captured page: a kit's own interstitial often moves
 * on through a button rather than a link ("One more step" → "Confirm").
 * Disabled and captionless controls cannot be clicked or named. References
 * are assigned in document order, one per caption, since the caption is how
 * the live page finds the control again.
 */
export function extractWebsiteContinuationControls(html: string): WebsiteContinuationControl[] {
	const controls: WebsiteContinuationControl[] = [];
	const seen = new Set<string>();
	for (const element of parse(html).querySelectorAll(CONTINUATION_CONTROL_SELECTOR)) {
		if (element.hasAttribute("disabled") || element.getAttribute("aria-hidden") === "true") continue;
		const label = controlCaption(element);
		if (!label || seen.has(label)) continue;
		seen.add(label);
		controls.push({ ref: `b${controls.length + 1}`, label });
		if (controls.length === MAX_CONTINUATION_CONTROLS) break;
	}
	return controls;
}
