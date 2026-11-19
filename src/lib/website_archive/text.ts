import { convert } from "mhtml-to-html";
import parse, { HTMLElement } from "node-html-parser";

const TEXT_ATTRIBUTES = ["placeholder", "aria-placeholder", "aria-label"] as const;
const CAPTION_INPUT_TYPES = new Set(["button", "reset", "submit"]);

/**
 * Text a visitor reads from attributes rather than text nodes: field hints,
 * button captions, image alternatives, and accessible labels. Kits often label
 * their fields only with placeholders and their buttons with input values.
 * Each caption becomes its own line where its element stands, so the text
 * keeps the order a visitor reads and a quote spanning a heading and the
 * fields below it appears in the text as it does on the page.
 */
function inlineAttributeText(dom: HTMLElement): void {
	for (const element of dom.querySelectorAll("[placeholder], [aria-placeholder], [aria-label], img[alt], input[value]")) {
		const tag = element.tagName.toLowerCase();
		const ownText = compactText(element.textContent);
		const captions = new Set([
			...TEXT_ATTRIBUTES.map((attribute) => element.getAttribute(attribute)),
			tag === "img" ? element.getAttribute("alt") : undefined,
			tag === "input" && CAPTION_INPUT_TYPES.has(element.getAttribute("type")?.trim().toLowerCase() ?? "") ? element.getAttribute("value") : undefined,
		].map(compactText).filter((caption) => caption && caption !== ownText));
		for (const caption of captions) {
			const line = new HTMLElement("div", {}, "");
			line.textContent = caption;
			element.before(line);
		}
	}
}

/** A string with its whitespace runs collapsed to single spaces. */
export function compactText(value: string | undefined): string {
	return value?.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Inline styles that keep an element's text from any visitor. Kits pad pages
 * with large blocks of such text (zero font size, zero opacity) so that a
 * scanner reading the document sees harmless filler instead of the login form.
 * Fractional values such as `opacity: 0.5` remain visible.
 */
const HIDING_INLINE_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?|font-size\s*:\s*0(?:px|pt|em|rem|%)?)\s*(?:!\s*important\s*)?(?=;|$)/i;

/** Frames nest this deep on real pages: Google Sites → Apps Script sandbox → the script's own page. */
const MAX_INLINED_FRAME_DEPTH = 5;

function parseDocument(html: string): HTMLElement {
	// The doctype parses as a text node and would otherwise lead the page text.
	return parse(html.replace(/^\s*<!DOCTYPE[^>]*>/i, ""), { comment: false });
}

/**
 * Replace each frame with the document it showed. Chromium's MHTML keeps a
 * frame's document in the frame's `srcdoc` once converted, where neither the
 * page text nor the field extraction would see it; a visitor sees it in place.
 * The frame's own hiding attributes move to its content.
 */
function inlineFrames(dom: HTMLElement, depth = 0): void {
	for (const frame of dom.querySelectorAll("iframe, frame")) {
		const srcdoc = frame.getAttribute("srcdoc");
		const content = new HTMLElement("div", {}, "");
		for (const attribute of ["hidden", "style"]) {
			const value = frame.getAttribute(attribute);
			if (value !== undefined) content.setAttribute(attribute, value);
		}
		if (srcdoc && depth < MAX_INLINED_FRAME_DEPTH) {
			const document = parseDocument(srcdoc);
			inlineFrames(document, depth + 1);
			content.set_content((document.querySelector("body") ?? document).innerHTML);
		}
		frame.replaceWith(content);
	}
}

/** What a visitor reads on a stored MHTML capture. */
export async function mhtmlVisitorText(mhtml: Buffer): Promise<string> {
	const { data } = await convert(mhtml, { enableScripts: false, fetchMissingResources: false });
	return capturedDocumentContent(data).text;
}

/** Sanitized HTML and visitor-readable text of a captured document, with its frames shown in place. */
export function capturedDocumentContent(documentHtml: string): { html: string; text: string } {
	const dom = parseDocument(documentHtml);
	const title = dom.querySelector("title")?.textContent ?? "";
	const description = dom.querySelector("meta[name='description'], meta[property='og:description'], meta[property='twitter:description']")?.getAttribute("content") ?? "";
	inlineFrames(dom);
	dom.querySelectorAll("script, style, link, svg, noscript").forEach((element) => element.remove());
	dom.querySelectorAll("[hidden], [style]")
		.filter((element) => element.hasAttribute("hidden") || HIDING_INLINE_STYLE.test(element.getAttribute("style") ?? ""))
		.forEach((element) => element.remove());
	dom.querySelectorAll("*").forEach((element) => element.removeAttribute("style"));
	const textDom = parse(dom.outerHTML);
	inlineAttributeText(textDom);
	dom.querySelectorAll("img").forEach((element) => element.remove());
	const text = [title, description, textDom.structuredText].filter(Boolean).join("\n\n")
		.replaceAll(/ +/g, " ")
		.replaceAll(/ *\n[\n ]*/g, "\n")
		.trim();
	return { html: dom.outerHTML, text };
}
