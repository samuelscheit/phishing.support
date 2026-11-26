import { unescapeHtml } from "../../util/html";

/** A provider message as plain text: what it says, and our report as it quoted it back, kept apart. */
export type CleanMailText = { main: string; quoted: string | null };

/**
 * Where a provider's message stops speaking and starts repeating our report:
 * Cloudflare's "Below is the report we received:", a forwarded or replied-to
 * original, or a line quoted with ">". The earliest one wins.
 */
const QUOTE_MARKERS: readonly RegExp[] = [
	/^[ \t]*Below is the report we received:?[ \t]*$/im,
	/^[ \t]*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}[ \t]*$/im,
	/^[ \t]*On .{4,200}\bwrote:[ \t]*$/im,
	/^[ \t]*>/m,
];

const AT_RULE = /@(?:media|font-face|import|supports|charset)\b/i;
const DECLARATION_BLOCK = /\{[^{}]*?[a-z-]+\s*:\s*[^;{}]+;[^{}]*\}/i;

/**
 * Where CSS a mail's HTML part leaked into its text begins: a `@media` rule,
 * or a `selector { property: value; }` block, whose selector starts after the
 * last sentence before it. Everything from there on is the template's style
 * sheet and the preheader repeated after it (Netcraft's notifications).
 */
function cssStart(text: string): number | undefined {
	const atRule = AT_RULE.exec(text)?.index;
	const block = DECLARATION_BLOCK.exec(text)?.index;
	const selectorStart = block === undefined ? undefined : Math.max(0, ...[...text.slice(0, block).matchAll(/[.!?](?=\s)|\n/g)].map((match) => match.index + 1));
	const starts = [atRule, selectorStart].filter((index): index is number => index !== undefined);
	return starts.length ? Math.min(...starts) : undefined;
}

/** The link list html-to-text appends ("References 1. https://… 2. https://…"): the links themselves, not words. */
const REFERENCES = /(?:^|\s)References\s+1\.\s+https?:\/\/[\s\S]*$/;

/** HTML as text: scripts and styles dropped, block ends as line breaks, the rest of the tags removed. */
function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:tr|li)>/gi, "\n")
		.replace(/<\/(?:p|div|h[1-6]|table|blockquote)>/gi, "\n\n")
		.replace(/<[^>]*>/g, " ");
}

/**
 * A provider message's body as clean, readable text: HTML turned into text,
 * entities decoded, leaked CSS and link lists cut, link markers ("[1]Check
 * results") unwrapped, and blank runs collapsed. Our own report, when the
 * provider quoted it back, is split off as `quoted`, so the page shows what
 * the provider said and keeps the rest folded.
 */
export function cleanMailText(body: string): CleanMailText {
	let text = /<(?:html|body|div|p|table|br)\b/i.test(body) ? htmlToText(body) : body;
	text = unescapeHtml(text).replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");
	const css = cssStart(text);
	if (css !== undefined) text = text.slice(0, css);
	text = text.replace(REFERENCES, "").replace(/\[\d{1,3}\]/g, "");
	text = text.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();

	const split = QUOTE_MARKERS.map((marker) => marker.exec(text)?.index).filter((index): index is number => index !== undefined && index > 0).sort((a, b) => a - b)[0];
	if (split === undefined) return { main: text, quoted: null };
	const quoted = text.slice(split).trim();
	return { main: text.slice(0, split).trim(), quoted: quoted || null };
}

/**
 * The first sentence that says something, for a message without a known
 * decision: the greeting ("Hello,", "Dear Abuse Team,") skipped, at most
 * `maximum` characters.
 */
export function leadSentence(main: string, maximum = 220): string | undefined {
	const lines = main.split("\n").map((line) => line.trim()).filter(Boolean);
	const body = lines.filter((line, index) => !(index === 0 && /^(?:hello|hi|dear|good (?:morning|afternoon|evening)|greetings)\b[^.!?]{0,80}[,!:]?$/i.test(line))).join(" ");
	const sentence = body.split(/(?<=[.!?])\s+/)[0]?.trim();
	if (!sentence) return undefined;
	return sentence.length > maximum ? `${sentence.slice(0, maximum - 1).replace(/\s+\S*$/, "")}…` : sentence;
}
