import { parsedUrl } from "./chain";

/** How a wrapper carried the URL it sends the visitor on to. */
export type WrapperEncoding = "plain" | "percent" | "base64";

export type WrappedUrl = {
	/** The query parameter (`target`) or `path` that carried it. */
	parameter: string;
	encoding: WrapperEncoding;
	url: string;
};

const MAX_LAYERS = 4;
/** Shorter base64 cannot hold an http(s) URL with a host. */
const MIN_BASE64_LENGTH = 16;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
/** A marker some wrappers put before the encoded value (`BASE64aHR0…`, `b64:aHR0…`). */
const BASE64_MARKER = /^(?:base64|b64)[:_,.-]?/i;

function base64Text(value: string): string | undefined {
	for (const candidate of new Set([value, value.replace(BASE64_MARKER, "")])) {
		if (candidate.length < MIN_BASE64_LENGTH || !BASE64.test(candidate)) continue;
		const decoded = Buffer.from(candidate.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
		// A URL, or another base64 layer of one.
		if (/^https?(?::|%)/i.test(decoded) || BASE64.test(decoded.replace(BASE64_MARKER, ""))) return decoded;
	}
	return undefined;
}

/** The value percent-decoded once, or undefined when it is not valid percent-encoding. */
export function percentDecoded(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

/**
 * The http(s) URL a wrapper value stands for: as it is, percent-encoded (once
 * or more) or base64-encoded (standard or URL-safe alphabet, optionally behind
 * a `BASE64`/`b64:` marker), in layers up to four deep. Anything else is not
 * a wrapped URL.
 */
export function decodeWrappedUrl(value: string): { url: string; encoding: WrapperEncoding } | undefined {
	let current = value.trim();
	let encoding: WrapperEncoding = "plain";
	for (let layer = 0; layer < MAX_LAYERS; layer++) {
		if (/^https?:\/\//i.test(current)) {
			const url = parsedUrl(current);
			return url?.hostname ? { url: url.toString(), encoding } : undefined;
		}
		if (/^https?%/i.test(current)) {
			const decoded = percentDecoded(current);
			if (!decoded) return undefined;
			current = decoded;
			if (encoding === "plain") encoding = "percent";
			continue;
		}
		const decoded = base64Text(current);
		if (!decoded) return undefined;
		current = decoded;
		encoding = "base64";
	}
	return undefined;
}

/**
 * Every URL a URL carries for the visitor's next step: in a query parameter
 * (`/redirect?target=BASE64aHR0…`, TUNE's `url=` deep link) or as a path
 * segment (`/go/aHR0cHM6Ly9…`). Each distinct URL once, in the order found.
 */
export function wrappedUrls(url: URL): WrappedUrl[] {
	const found: WrappedUrl[] = [];
	const add = (parameter: string, value: string) => {
		// A query string decodes an unescaped base64 `+` to a space.
		const decoded = decodeWrappedUrl(value) ?? (value.includes(" ") ? decodeWrappedUrl(value.replace(/ /g, "+")) : undefined);
		if (decoded && !found.some((item) => item.url === decoded.url)) found.push({ parameter, ...decoded });
	};
	for (const [name, value] of url.searchParams) add(name, value);
	for (const segment of url.pathname.split("/")) {
		if (segment.length >= MIN_BASE64_LENGTH) add("path", percentDecoded(segment) ?? segment);
	}
	return found;
}
