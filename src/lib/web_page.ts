/** Media types a browser renders as a web page; anything else (a script, a stylesheet, JSON) is a file. */
const PAGE_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Whether a response with this Content-Type is a page a visitor is shown.
 * A missing type counts as a page: browsers sniff it as one.
 */
export function isWebPage(contentType: string | undefined): boolean {
	const type = contentType?.split(";", 1)[0]!.trim().toLowerCase();
	return !type || PAGE_TYPES.has(type);
}
