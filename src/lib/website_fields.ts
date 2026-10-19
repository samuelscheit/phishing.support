import { parse, type HTMLElement } from "node-html-parser";

import type { WebsiteDataEntryField } from "./website_types";

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
