import { assertPublicDnsHost } from "../abuse/security";
import { urlHostname } from "../abuse/skyvern/storage";

export type PublicFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type PublicRedirectDependencies = {
	fetch?: PublicFetch;
	assertPublicHost?: (hostname: string) => Promise<void>;
	signal?: AbortSignal;
};

export type PublicRedirectOptions = PublicRedirectDependencies & {
	/** Names what is fetched in errors: "The payload host answered …". */
	subject: string;
	headers: Record<string, string>;
	maxRedirects: number;
	/** Bounds each request; the response body is the caller's to bound. */
	timeoutMs: number;
};

export type PublicRedirectResult = {
	/** The first answer that is not an HTTP redirect; its body is unread. */
	response: Response;
	/** Every URL the chain reached, in order; the last one answered `response`. */
	urls: string[];
};

/** A failed fetch, with every URL the chain reached; the last one is where it failed (an unsafe or unresolvable host is never requested). */
export class PublicRedirectError extends Error {
	constructor(readonly urls: readonly string[], cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "PublicRedirectError";
	}
}

/**
 * Fetch a URL from an untrusted source, following HTTP redirects by hand so
 * that every hop is checked: credential-free HTTP(S) on a host that resolves
 * only to public addresses. Nothing reaches the private network through a
 * redirect.
 */
export async function fetchThroughPublicRedirects(url: string, options: PublicRedirectOptions): Promise<PublicRedirectResult> {
	const fetchImplementation = options.fetch ?? fetch;
	const assertPublicHost = options.assertPublicHost ?? ((hostname: string) => assertPublicDnsHost(hostname));
	const urls: string[] = [];
	try {
		let current = new URL(url);
		for (let redirects = 0; redirects <= options.maxRedirects; redirects++) {
			if (!["http:", "https:"].includes(current.protocol) || current.username || current.password) {
				throw new Error(`The ${options.subject} URL is not a credential-free HTTP(S) URL.`);
			}
			urls.push(current.toString());
			await assertPublicHost(urlHostname(current));
			const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
			const response = await fetchImplementation(current, { redirect: "manual", headers: options.headers, signal });
			if (response.status < 300 || response.status >= 400) return { response, urls };
			const location = response.headers.get("location");
			await response.body?.cancel().catch(() => undefined);
			if (!location) throw new Error(`The ${options.subject} host redirected without a location.`);
			current = new URL(location, current);
		}
		throw new Error(`The ${options.subject} host exceeded the redirect limit.`);
	} catch (error) {
		throw new PublicRedirectError(urls, error);
	}
}
