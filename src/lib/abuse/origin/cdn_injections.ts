/**
 * Tags a CDN inserts into the HTML it proxies, so the document a visitor
 * receives is not byte-for-byte the one the origin served. The same kit
 * page on a host without the CDN, as urlscan and the origin itself serve it,
 * has none of them: its hash is the document's with these removed.
 *
 * - Cloudflare Web Analytics adds `<script defer|type="module"
 *   src="https://static.cloudflareinsights.com/beacon.min.js/…"
 *   data-cf-beacon='…'></script>` and a line break before `</body>`
 *   (production case 377486973465530391: the exploit loader frame grew from
 *   11,264 to 11,631 bytes).
 * - Cloudflare's bot management adds an inline script that loads
 *   `/cdn-cgi/challenge-platform/…` into a hidden iframe.
 */
const INJECTIONS: readonly RegExp[] = [
	/<script\b[^>]*\bsrc=["']https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js[^"']*["'][^>]*>\s*<\/script>\n?/gi,
	/<script\b[^>]*>(?:(?!<\/script>)[\s\S]){0,4000}?\/cdn-cgi\/challenge-platform\/(?:(?!<\/script>)[\s\S]){0,4000}?<\/script>\n?/gi,
];

/**
 * The document as its origin served it. Bytes are matched as latin1 so
 * every other byte comes back unchanged, whatever the document's encoding.
 * Returns undefined when the CDN inserted nothing.
 */
export function withoutCdnInjections(document: Buffer): Buffer | undefined {
	const original = document.toString("latin1");
	const stripped = INJECTIONS.reduce((text, injection) => text.replace(injection, ""), original);
	return stripped === original ? undefined : Buffer.from(stripped, "latin1");
}
