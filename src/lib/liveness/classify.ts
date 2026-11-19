import { parse } from "tldts";

import { urlHostname } from "../network/public_redirects";
import type { SiteCheckState } from "./schema";
import { matchPageSignature, type SitePage } from "./signatures";

/** What DNS said about the visited host. An IP literal host is `resolved` to itself. */
export type DnsObservation =
	| { outcome: "resolved"; addresses: string[] }
	/** The name does not exist. `cname` is set when the host itself exists and only its CNAME target is gone. */
	| { outcome: "nxdomain"; cname?: string }
	/** No answer either way: SERVFAIL, a timeout, or a name without addresses. */
	| { outcome: "failed"; error: string };

export type HttpObservation =
	| { outcome: "response"; page: SitePage; urls: string[] }
	/** No HTTP answer: refused, timed out, TLS failure, an unsafe or endless redirect. */
	| { outcome: "failed"; error: string; urls: string[] };

export type SiteObservation = {
	url: string;
	dns: DnsObservation;
	/** The registrable domain's RDAP status values; empty when unknown. */
	domainStatuses: readonly string[];
	/** Absent when DNS already showed the name gone. */
	http?: HttpObservation;
};

export type SiteVerdict = { state: SiteCheckState; detail: string };

/** RDAP writes `client hold`; EPP and some servers `clientHold`. */
const HOLD_STATUSES = new Set(["clienthold", "serverhold"]);

function holdStatus(statuses: readonly string[]): string | undefined {
	return statuses.find((status) => HOLD_STATUSES.has(status.toLowerCase().replace(/[\s_-]/g, "")));
}

/**
 * The site a host belongs to: its registrable domain, where a platform's
 * tenant (`kit.pages.dev`) counts as a site of its own. An IP is its own site.
 */
export function siteOf(host: string): { site: string; platform?: string } {
	const parsed = parse(host, { allowPrivateDomains: true });
	if (parsed.isIp || !parsed.domain) return { site: host };
	return parsed.isPrivate && parsed.publicSuffix ? { site: parsed.domain, platform: parsed.publicSuffix } : { site: parsed.domain };
}

/**
 * Decide what one visit found. The evidence closest to the name decides
 * first: a name that is gone, then a registry hold, then the page that
 * answered, and the HTTP status last.
 */
export function classifySite(observation: SiteObservation): SiteVerdict {
	const host = urlHostname(new URL(observation.url));
	if (observation.dns.outcome === "nxdomain") {
		// A dangling CNAME or a platform tenant without its DNS name means the
		// host deleted the site; the domain's own registration is untouched.
		if (observation.dns.cname) return { state: "removed", detail: `The site's CNAME target ${observation.dns.cname} no longer exists (NXDOMAIN).` };
		const { platform } = siteOf(host);
		if (platform) return { state: "removed", detail: `The platform ${platform} no longer has ${host} (NXDOMAIN).` };
		return { state: "domain_gone", detail: `${host} no longer resolves (NXDOMAIN).` };
	}
	const hold = holdStatus(observation.domainStatuses);
	if (hold) return { state: "domain_suspended", detail: `The registry lists the domain as ${hold}.` };

	const http = observation.http;
	if (!http) return { state: "unreachable", detail: observation.dns.outcome === "failed" ? `DNS failed: ${observation.dns.error}` : "The site was not visited." };
	if (http.outcome === "failed") return { state: "unreachable", detail: `No answer: ${http.error}` };

	const { page } = http;
	const signature = matchPageSignature(page);
	if (signature) return { state: signature.state, detail: `${signature.name} (HTTP ${page.status}).` };

	const finalHost = urlHostname(new URL(page.url));
	if (siteOf(finalHost).site !== siteOf(host).site) return { state: "redirected", detail: `Redirected to ${finalHost} (HTTP ${page.status}).` };

	if (page.status === 404 || page.status === 410) return { state: "removed", detail: `HTTP ${page.status}.` };
	// Unavailable For Legal Reasons: the host blocked the page on a complaint.
	if (page.status === 451) return { state: "host_suspended", detail: "HTTP 451." };
	if (page.status >= 500) return { state: "unreachable", detail: `HTTP ${page.status}.` };
	// Any other answer is the site: a login wall, a bot check, or a kit cloaking itself with a 403.
	return { state: "online", detail: `HTTP ${page.status}.` };
}
