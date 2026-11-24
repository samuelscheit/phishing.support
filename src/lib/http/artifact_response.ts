/**
 * Raster image types a browser only ever paints: shown inline, so a case's
 * screenshots open in a tab and fill an `<img>`. SVG is not among them: it
 * carries script.
 */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** RFC 5987 `attr-char`s: what `encodeURIComponent` leaves alone except `'()*`, which `filename*` must encode. */
function encodeRfc5987(value: string): string {
	return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The RFC 6266 disposition naming the file: the exact name as UTF-8 in
 * `filename*`, and a plain ASCII stand-in in `filename` for clients that do
 * not read it. A name is whatever a mail or a page called it, so quotes,
 * backslashes, line breaks and non-ASCII never reach the quoted string.
 */
export function contentDisposition(type: "inline" | "attachment", name: string): string {
	const fallback = name.replace(/[^\x20-\x7e]|["\\%]/gu, "_");
	return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

/**
 * A stored artifact as the browser may receive it. Artifacts are what a
 * phishing kit, a mail or a provider sent us (HTML with script, MHTML, a raw
 * chain body), and they are served from our own origin: anything but a
 * raster image is a download the browser never renders, never sniffs into
 * another type, and, opened anyway, runs sandboxed with no script and no
 * origin. Artifacts never change once stored, so public ones may be cached.
 */
export function artifactResponse(
	artifact: { blob: Buffer; mimeType: string | null; name: string | null },
	options: { access: "public" | "private"; charset?: string },
): Response {
	const mimeType = artifact.mimeType || "application/octet-stream";
	const inline = INLINE_IMAGE_TYPES.has(mimeType.split(";")[0]!.trim().toLowerCase());
	return new Response(artifact.blob as unknown as BodyInit, {
		headers: {
			"content-type": options.charset ? `${mimeType}; charset=${options.charset}` : mimeType,
			"content-disposition": contentDisposition(inline ? "inline" : "attachment", artifact.name || "artifact"),
			"content-security-policy": "sandbox",
			"x-content-type-options": "nosniff",
			"cache-control": options.access === "public" ? "public, max-age=31536000, immutable" : "private, no-store",
		},
	});
}
