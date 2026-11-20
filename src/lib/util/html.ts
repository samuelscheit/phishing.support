const ESCAPES: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };

/** Text safe inside HTML or XML element content and attribute values. */
export function escapeHtml(value: string): string {
	return value.replace(/[<>&'"]/g, (character) => ESCAPES[character]!);
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };

/**
 * The text an HTML-escaped string stands for ("Subnet &amp; Telecom",
 * "&#34;Email&#34;", Go's html.EscapeString output). Decodes the five XML
 * entities, `&nbsp;` and numeric references once; anything else stays as written.
 */
export function unescapeHtml(value: string): string {
	return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (entity, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
		const codePoint = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : undefined;
		if (codePoint !== undefined) return codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff) ? String.fromCodePoint(codePoint) : entity;
		return NAMED_ENTITIES[name!.toLowerCase()] ?? entity;
	});
}
