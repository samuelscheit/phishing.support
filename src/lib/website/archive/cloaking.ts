import type { FabricEgress } from "../../browser/fabric";
import { siteOf } from "../../network/registered_domain";
import type { WebsiteCloakedDestination, WebsiteCloaking, WebsiteNavigationHop } from "../types";
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

function siteOfUrl(url: string): string {
	return siteOf(new URL(url).hostname).site;
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
	const scripted = archive.navigationHops.find((hop) => hop.redirectTo && !isHttpRedirect(hop.status) && siteOfUrl(hop.redirectTo) !== siteOfUrl(hop.url));
	return scripted ? siteOfUrl(archive.url) : undefined;
}

function isHttpRedirect(status: number | null): boolean {
	return status !== null && status >= 300 && status < 400;
}

/** What a case says when its capture holds only a decoy: nothing is judged or reported from it. */
export function cloakingSuspectedInfo(cloaking: WebsiteCloaking): string {
	return `Cloaking suspected: ${cloaking.detail}. No verdict or report was made from the decoy; retry to visit the site again.`;
}

/**
 * A page whose script sent the residential exit to another site, and a chain
 * that then shows nothing reportable, is a cloaker that picks a harmless decoy
 * for every visitor (docusign.alt3-doc3ea7-v2.sbs sends each one to a random
 * news front page), not where it leads its real victims: the decoy becomes an
 * unresolved cloaking, so a retry visits the site again.
 */
export function harmlessScriptedDestination(cloaking: WebsiteCloaking): WebsiteCloaking {
	return { outcome: "unresolved", detail: `${cloaking.detail}, which shows nothing reportable` };
}

/** What the case says when every network was turned away by the flow's destination. */
export function cloakedDestinationInfo(cloaked: WebsiteCloakedDestination): string {
	const untried = cloaked.notTried.length ? ` ${cloaked.notTried.map(({ network, reason }) => `The ${network} could not be tried: ${reason}.`).join(" ")}` : "";
	return `The site's flow leads to ${cloaked.host}, which answered every network we tried (${cloaked.answered.join(", ")}) with an empty response and sent the visit back; no report was created.${untried}`;
}


/**
 * The other site a visit's flow was sent to, when that site only answered
 * with nothing (a 204, or a page of any status that moves on at once by
 * script, never shown or acted on) and the visitor ended
 * up back on the submitted site, or on that empty answer. That is how a
 * traffic distribution system turns away a visitor it filters out. Ordinary
 * redirects, destinations that show a page (also one the visitor acted on and
 * left, back through the submitted tracker), and requests inside a page (they
 * are not navigation hops) are none of this.
 */
export function cloakedDestination(hops: readonly WebsiteNavigationHop[], submittedUrl: string): { host: string; site: string } | undefined {
	const submitted = siteOfUrl(submittedUrl);
	const empty = (hop: WebsiteNavigationHop) => !hop.contentCaptured && !hop.visitorStep && hop.status !== null && (hop.status === 204 || (hop.redirectTo !== undefined && !isHttpRedirect(hop.status)));
	for (const [position, hop] of hops.entries()) {
		if (siteOfUrl(hop.url) === submitted || !empty(hop)) continue;
		const cameFrom = hops[position - 1];
		if (!cameFrom || siteOfUrl(cameFrom.url) !== submitted) continue;
		const back = hop.redirectTo ?? hops[position + 1]?.url;
		if (back === undefined ? hop.status === 204 : siteOfUrl(back) === submitted) return { host: hop.hostname, site: siteOfUrl(hop.url) };
	}
	return undefined;
}
