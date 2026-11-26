import { Parser } from "htmlparser2";

/**
 * One icon a page declares: where it is, and what the page says it is.
 * `sizes` holds the square edge lengths it declares (`any` is 0: a vector).
 */
export type IconCandidate = { url: string; rel: "icon" | "apple-touch-icon" | "mask-icon" | "fallback"; sizes: number[]; type?: string };

/** The edge length the pages draw an icon at, at 2x: 32 CSS pixels. */
export const ICON_EDGE = 64;
/** A raster smaller than this looks blurred at `ICON_EDGE`. */
const MIN_RASTER_EDGE = 32;

const REL_KIND: ReadonlyArray<[RegExp, IconCandidate["rel"]]> = [
	[/(?:^|\s)apple-touch-icon(?:-precomposed)?(?:\s|$)/, "apple-touch-icon"],
	[/(?:^|\s)mask-icon(?:\s|$)/, "mask-icon"],
	[/(?:^|\s)icon(?:\s|$)/, "icon"],
];

/** `sizes="16x16 32x32 any"` → [16, 32, 0]; non-square sizes are left out. */
function squareSizes(sizes: string | undefined): number[] {
	return (sizes ?? "").toLowerCase().split(/\s+/).flatMap((size) => {
		if (size === "any") return [0];
		const match = /^(\d+)x(\d+)$/.exec(size);
		return match && match[1] === match[2] ? [Number(match[1])] : [];
	});
}

const isVector = (candidate: IconCandidate) => candidate.type === "image/svg+xml" || /\.svg(?:$|[?#])/i.test(candidate.url) || /^data:image\/svg\+xml[;,]/i.test(candidate.url) || candidate.sizes.includes(0);

/**
 * How well an icon fits a 32 px badge, lower first: a declared square raster
 * of at least 32 px (the one nearest 64 px first), an Apple touch icon (a
 * square raster, often 180 px), a vector, a raster of no declared size, then
 * a declared raster below 32 px. A Safari pinned-tab mask is a one-colour
 * silhouette: last.
 */
function rank(candidate: IconCandidate): number {
	if (candidate.rel === "mask-icon") return 6_000;
	if (candidate.rel === "fallback") return 5_000;
	const raster = candidate.sizes.filter((size) => size > 0);
	const fit = raster.filter((size) => size >= MIN_RASTER_EDGE).map((size) => Math.abs(size - ICON_EDGE) + (size < ICON_EDGE ? 0.5 : 0));
	if (fit.length > 0) return Math.min(...fit);
	if (candidate.rel === "apple-touch-icon") return 1_000;
	if (isVector(candidate)) return 2_000;
	if (raster.length === 0) return 3_000;
	return 4_000 + ICON_EDGE - Math.max(...raster);
}

/** A URL of the page, or none when it is not one a browser would load as an image (an empty href is the page itself). */
function resolve(href: string, base: URL): string | undefined {
	if (!href.trim()) return undefined;
	try {
		const url = new URL(href.trim(), base);
		return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "data:" ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The icons a page declares in `<link rel>` (icon, shortcut icon,
 * apple-touch-icon, mask-icon), resolved against its `<base href>` and
 * address, best first (see `rank`), then `/favicon.ico` of the address the
 * page was served from. `data:` icons are kept: they need no request.
 */
export function iconCandidates(html: string, pageUrl: string): IconCandidate[] {
	const page = new URL(pageUrl);
	let base = page;
	const declared: Array<Omit<IconCandidate, "url"> & { href: string }> = [];
	const parser = new Parser({
		onopentag(name, attributes) {
			if (name === "base" && attributes.href && base === page) {
				const url = resolve(attributes.href, page);
				if (url && !url.startsWith("data:")) base = new URL(url);
				return;
			}
			if (name !== "link" || !attributes.href) return;
			const rel = (attributes.rel ?? "").toLowerCase();
			const kind = REL_KIND.find(([pattern]) => pattern.test(rel))?.[1];
			if (!kind) return;
			declared.push({ href: attributes.href, rel: kind, sizes: squareSizes(attributes.sizes), ...(attributes.type ? { type: attributes.type.toLowerCase() } : {}) });
		},
	}, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
	parser.end(html);
	const candidates = declared.flatMap(({ href, ...rest }) => {
		const url = resolve(href, base);
		return url ? [{ url, ...rest }] : [];
	});
	candidates.push({ url: new URL("/favicon.ico", page).toString(), rel: "fallback", sizes: [] });
	const seen = new Set<string>();
	return candidates
		.map((candidate, order) => ({ candidate, order }))
		.sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.order - b.order)
		.flatMap(({ candidate }) => {
			if (seen.has(candidate.url)) return [];
			seen.add(candidate.url);
			return [candidate];
		});
}

/** The bytes of a `data:` URL, base64 or percent-encoded, with the type it declares. */
export function decodeDataUrl(url: string): { bytes: Buffer; type: string } | undefined {
	const match = /^data:([^,]*?),(.*)$/is.exec(url);
	if (!match) return undefined;
	const meta = match[1]!.split(";").map((part) => part.trim().toLowerCase());
	const base64 = meta.includes("base64");
	const body = match[2]!;
	try {
		return { type: meta[0] || "text/plain", bytes: base64 ? Buffer.from(decodeURIComponent(body), "base64") : Buffer.from(decodeURIComponent(body), "utf8") };
	} catch {
		return undefined;
	}
}
