import { AbuseInputError } from "../abuse/security/security";
import { fetchThroughPublicRedirects, PublicRedirectError, type PublicRedirectDependencies } from "../network/public_redirects";
import { browserRequestHeaders } from "../network/service_identity";
import { decodeDataUrl, iconCandidates } from "./discover";
import { MAX_ICON_BYTES, normalizeIcon, NotAnIconError } from "./image";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
/** The page is read only this far: its `<link rel=icon>` tags are in its head. */
const MAX_PAGE_BYTES = 512 * 1024;
/** Declared icons tried before giving up; a site rarely declares more that work. */
const MAX_ATTEMPTS = 5;

/**
 * A public index of site icons, for a site whose own server refuses us:
 * NameSilo's Cloudflare bot wall answers every non-browser client 403, its
 * `/favicon.ico` too (probed 2026-11-27). Asked from our server, so a
 * visitor's browser still never contacts it. It answers 404 (with a generic
 * globe) for a domain it has no icon of, so its answer is the site's own.
 */
export const iconIndexUrl = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

export type FaviconDependencies = PublicRedirectDependencies;

/**
 * Why a fetch got no icon: the server answered with an HTTP error
 * (`http`), it could not be reached (`network`), the address is not a
 * public one (`refused`), or what it served is no icon (`invalid`).
 */
export type FetchFailure = "http" | "network" | "refused" | "invalid";

/**
 * Where a stored icon came from: the icon file's address (`file`), or for an
 * icon inlined as a `data:` URL, the page that declared it (`inline`).
 * Either is what a revalidation asks again.
 */
export type IconSource = { url: string; kind: "file" | "inline" };

export type Extraction =
	| { found: true; png: Buffer; source: IconSource }
	| { found: false; failure: FetchFailure; reason: string };

class FetchError extends Error {
	constructor(readonly failure: FetchFailure, message: string) {
		super(message);
		this.name = "FetchError";
	}
}

/** The first `max` bytes of a body; the rest is never read. */
async function readPrefix(response: Response, max: number): Promise<Buffer> {
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		while (size < max) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(Buffer.from(value));
			size += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks).subarray(0, max);
}

/**
 * One GET through public addresses only, every redirect checked, with the
 * desktop browser's headers a provider's own site expects (a bare client
 * meets its WAF). Returns the body up to `maxBytes` (an icon's bound, or
 * the page's head), or throws a `FetchError` that says why there is none.
 */
async function get(url: string, accept: string, maxBytes: number, dependencies: FaviconDependencies, options: { truncate: boolean }): Promise<{ body: Buffer; finalUrl: string }> {
	let result;
	try {
		result = await fetchThroughPublicRedirects(url, {
			...dependencies,
			subject: "favicon",
			headers: { ...browserRequestHeaders, accept },
			maxRedirects: MAX_REDIRECTS,
			timeoutMs: FETCH_TIMEOUT_MS,
		});
	} catch (error) {
		const cause = error instanceof PublicRedirectError ? error.cause : error;
		throw new FetchError(cause instanceof AbuseInputError ? "refused" : "network", error instanceof Error ? error.message : String(error));
	}
	const { response, urls } = result;
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new FetchError("http", `${urls.at(-1)} answered HTTP ${response.status}.`);
	}
	const length = Number(response.headers.get("content-length"));
	if (!options.truncate && Number.isFinite(length) && length > maxBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw new FetchError("invalid", `${urls.at(-1)} is ${length} bytes, more than ${maxBytes}.`);
	}
	try {
		// One byte past the bound tells a file that is too big from one that fits.
		const body = await readPrefix(response, options.truncate ? maxBytes : maxBytes + 1);
		return { body, finalUrl: urls.at(-1)! };
	} catch (error) {
		throw new FetchError("network", error instanceof Error ? error.message : String(error));
	}
}

/** The icon at an address (a file, or a `data:` URL), drawn as our PNG. */
async function fetchIcon(url: string, dependencies: FaviconDependencies): Promise<Buffer> {
	const inline = url.startsWith("data:") ? decodeDataUrl(url) : undefined;
	if (url.startsWith("data:") && !inline) throw new FetchError("invalid", "The data: URL does not decode.");
	const bytes = inline?.bytes ?? (await get(url, "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5", MAX_ICON_BYTES, dependencies, { truncate: false })).body;
	try {
		return await normalizeIcon(bytes);
	} catch (error) {
		if (error instanceof NotAnIconError) throw new FetchError("invalid", `${url.startsWith("data:") ? "An inline icon" : url}: ${error.message}`);
		throw error;
	}
}

const failureOf = (error: unknown): FetchFailure => (error instanceof FetchError ? error.failure : "network");

/**
 * The icon of a site: the icons its home page `https://<domain>/` declares,
 * best first, then `/favicon.ico`, until one is an image, and when the site
 * gives none, the icon index's (`iconIndexUrl`). A site on a non-public
 * address is never looked up anywhere. When nothing works the failure is
 * the site's own (see `extractFromSite`).
 */
export async function extractFavicon(domain: string, dependencies: FaviconDependencies = {}): Promise<Extraction> {
	const own = await extractFromSite(domain, dependencies);
	if (own.found || own.failure === "refused") return own;
	const index = iconIndexUrl(domain);
	try {
		return { found: true, png: await fetchIcon(index, dependencies), source: { url: index, kind: "file" } };
	} catch (error) {
		return { ...own, reason: `${own.reason} The icon index has none: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * The site's own icon. A home page that answers with an HTTP error still
 * has its `/favicon.ico` tried. When none works the failure says why:
 * `network` or `refused` when its home page could not be fetched at all,
 * else `http` when the last icon tried answered with one, else `invalid`.
 */
async function extractFromSite(domain: string, dependencies: FaviconDependencies): Promise<Extraction> {
	const home = `https://${domain}/`;
	let page: { html: string; url: string } | undefined;
	let pageFailure: FetchError | undefined;
	try {
		const { body, finalUrl } = await get(home, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", MAX_PAGE_BYTES, dependencies, { truncate: true });
		page = { html: body.toString("utf8"), url: finalUrl };
	} catch (error) {
		if (!(error instanceof FetchError)) throw error;
		if (error.failure === "network" || error.failure === "refused") return { found: false, failure: error.failure, reason: error.message };
		pageFailure = error;
	}
	const candidates = page ? iconCandidates(page.html, page.url) : iconCandidates("", home);
	const reasons: string[] = pageFailure ? [pageFailure.message] : [];
	let last: FetchFailure = pageFailure?.failure ?? "invalid";
	for (const candidate of candidates.slice(0, MAX_ATTEMPTS)) {
		try {
			const png = await fetchIcon(candidate.url, dependencies);
			const source: IconSource = candidate.url.startsWith("data:") ? { url: page!.url, kind: "inline" } : { url: candidate.url, kind: "file" };
			return { found: true, png, source };
		} catch (error) {
			last = failureOf(error);
			reasons.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { found: false, failure: last, reason: reasons.join(" ") || "The site declares no icon." };
}

export type Revalidation =
	| { kind: "unchanged" }
	| { kind: "updated"; png: Buffer }
	/** The source answers with an HTTP error or is no icon any more: the stored icon is dropped. */
	| { kind: "gone"; reason: string }
	/** The source could not be asked; the stored icon stays. */
	| { kind: "unreachable"; reason: string };

/**
 * Ask a stored icon's source again. An icon file is fetched and drawn
 * again (`updated` when it changed); an inline icon's page only has to
 * answer. An HTTP error, or a file that is no image any more, means the
 * icon is gone; a network failure says nothing about it.
 */
export async function revalidateFavicon(source: IconSource, stored: Buffer, dependencies: FaviconDependencies = {}): Promise<Revalidation> {
	try {
		if (source.kind === "inline") {
			await get(source.url, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", 1, dependencies, { truncate: true });
			return { kind: "unchanged" };
		}
		const png = await fetchIcon(source.url, dependencies);
		return png.equals(stored) ? { kind: "unchanged" } : { kind: "updated", png };
	} catch (error) {
		const failure = failureOf(error);
		const reason = error instanceof Error ? error.message : String(error);
		return failure === "network" ? { kind: "unreachable", reason } : { kind: "gone", reason };
	}
}
