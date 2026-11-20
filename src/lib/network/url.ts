/** A URL's hostname for display; what was given, when it is no URL. */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/** The host as `isIP` and DNS take it: WHATWG URLs keep IPv6 literals in brackets. */
export function urlHostname(url: URL): string {
	return url.hostname.replace(/^\[|\]$/g, "");
}

/** The hostname of an absolute URL without a leading "www."; throws on a non-URL. */
export function bareHost(url: string): string {
	return new URL(url).hostname.replace(/^www\./, "");
}

/** A DNS name without its root label ("example.com." is "example.com"). */
export function trimTrailingDot(name: string): string {
	return name.replace(/\.$/, "");
}

/** A DNS name in the lowercase, root-label-free form used as a lookup key. */
export function canonicalHost(name: string): string {
	return trimTrailingDot(name.toLowerCase());
}
