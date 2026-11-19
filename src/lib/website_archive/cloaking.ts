import { getDomain } from "tldts";

import type { FabricEgress } from "../browser/fabric";
import type { WebsiteArchiveResult } from "./types";

/**
 * Egress routes tried for a live capture, in order. Tor keeps the reporting
 * server's address away from attacker infrastructure, but Tor exits are widely
 * blocked, either with an HTTP error page or by dropping the connection; a page
 * that is unreachable over Tor is retried from the server's own direct exit.
 * Cloakers go further and answer Tor and datacenter visitors with a script
 * navigation to an unrelated decoy site; only then is the capture repeated from
 * the operator's residential exit, which exposes that connection's address.
 */
export const WEBSITE_CAPTURE_EGRESS: readonly FabricEgress[] = ["phishing", "reporting"];
export const WEBSITE_CLOAKING_EGRESS: FabricEgress = "residential";

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

