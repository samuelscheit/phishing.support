import { getDomain } from "tldts";

import type { FabricEgress } from "../../browser/fabric";
import type { WebsiteNavigationHop } from "../types";
import type { WebsiteArchiveResult } from "./types";

/**
 * Egress routes tried for a live capture, in order; the first that reaches the
 * page is kept. Cloakers answer Tor and datacenter visitors with a decoy (an
 * error page, a redirect to an unrelated site, even another page on the same
 * host), so the operator's residential exit, which sees what a victim sees, goes
 * first. When it is unavailable, Tor keeps the reporting server's address away
 * from attacker infrastructure; Tor exits are widely blocked, so a page that is
 * unreachable over Tor is tried from the server's own direct exit last.
 */
export const WEBSITE_CAPTURE_EGRESS: readonly FabricEgress[] = ["residential", "phishing", "reporting"];

/** Registrable domain (eTLD+1) of a URL, falling back to its hostname. */
export function siteOf(url: string): string {
	const { hostname } = new URL(url);
	return getDomain(hostname) ?? hostname;
}

/**
 * The site a capture's submitted page sent the visitor to by script, or
 * undefined when the capture stayed on the submitted site or followed an HTTP
 * redirect (the submitted host's declared destination).
 */
export function scriptDestinationSite(archive: WebsiteArchiveResult): string | undefined {
	// The page that ran the script is the one that answered with a document
	// instead of an HTTP redirect. Short links reach a cloaker through HTTP
	// redirects of their own, which say nothing about where its script sends
	// this visitor.
	const scripted = archive.navigationHops.find((hop) => hop.redirectTo && !isHttpRedirect(hop.status) && siteOf(hop.redirectTo) !== siteOf(hop.url));
	return scripted ? siteOf(archive.url) : undefined;
}

function isHttpRedirect(status: number | null): boolean {
	return status !== null && status >= 300 && status < 400;
}


/**
 * The other site a visit's flow was sent to, when that site only answered
 * with nothing (a 204, or a 2xx that moves on at once) and the visitor ended
 * up back on the submitted site, or on that empty answer. That is how a
 * traffic distribution system turns away a visitor it filters out. Ordinary
 * redirects, destinations that show a page, and requests inside a page (they
 * are not navigation hops) are none of this.
 */
export function cloakedDestination(hops: readonly WebsiteNavigationHop[], submittedUrl: string): { host: string; site: string } | undefined {
	const submitted = siteOf(submittedUrl);
	const empty = (hop: WebsiteNavigationHop) => !hop.contentCaptured && hop.status !== null && hop.status >= 200 && hop.status < 300 && (hop.status === 204 || hop.redirectTo !== undefined);
	for (const [position, hop] of hops.entries()) {
		if (siteOf(hop.url) === submitted || !empty(hop)) continue;
		const cameFrom = hops[position - 1];
		if (!cameFrom || siteOf(cameFrom.url) !== submitted) continue;
		const back = hop.redirectTo ?? hops[position + 1]?.url;
		if (back === undefined ? hop.status === 204 : siteOf(back) === submitted) return { host: hop.hostname, site: siteOf(hop.url) };
	}
	return undefined;
}
