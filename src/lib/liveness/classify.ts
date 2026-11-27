import type { SiteCheckState } from "./schema";
import { matchPageSignature, type SitePage } from "./signatures";
import { suspensionNameserver } from "./suspension_nameservers";
import { classifyBareErrorPage } from "../network/error_page";
import { urlHostname } from "../network/url";
import { siteOf } from "../network/registered_domain";

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
	/** The nameservers the registry delegates the registrable domain to; empty when unknown. */
	nameservers?: readonly string[];
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
 * Decide what one visit found. The evidence closest to the name decides
 * first: a registry hold, then a name that is gone, then whether anything
 * answered, then what the page that answered is (a provider's takedown,
 * parking or not-found page, by its content), where it ended, and whether it
 * is a bare error page. The HTTP status alone decides only for an empty
 * body: kits answer 403, 404, 451 or 500 with their live page, and a site
 * could forge a takedown by its status. No status or bare error page ever
 * yields a state of `TAKEN_DOWN_STATES`.
 */
export function classifySite(observation: SiteObservation): SiteVerdict {
	const host = urlHostname(new URL(observation.url));
	// The registry's word comes before what resolvers say: a suspended domain
	// answers NXDOMAIN, SERVFAIL or, from a stale cache, its old address.
	const hold = holdStatus(observation.domainStatuses);
	if (hold) return { state: "domain_suspended", detail: `The registry lists the domain as ${hold}.` };
	const suspension = suspensionNameserver(observation.nameservers ?? []);
	if (suspension) return { state: "domain_suspended", detail: `The registry delegates the domain to the suspension nameserver ${suspension}.` };
	if (observation.dns.outcome === "nxdomain") {
		// A dangling CNAME or a platform tenant without its DNS name means the
		// host deleted the site; the domain's own registration is untouched.
		if (observation.dns.cname) return { state: "removed", detail: `The site's CNAME target ${observation.dns.cname} no longer exists (NXDOMAIN).` };
		const { platform } = siteOf(host);
		if (platform) return { state: "removed", detail: `The platform ${platform} no longer has ${host} (NXDOMAIN).` };
		return { state: "domain_gone", detail: `${host} no longer resolves (NXDOMAIN).` };
	}

	const http = observation.http;
	if (!http) return { state: "unreachable", detail: observation.dns.outcome === "failed" ? `DNS failed: ${observation.dns.error}` : "The site was not visited." };
	if (http.outcome === "failed") return { state: "unreachable", detail: `No answer: ${http.error}` };

	const { page } = http;
	const signature = matchPageSignature(page);
	if (signature) return { state: signature.state, detail: `${signature.name} (HTTP ${page.status}).` };

	const finalHost = urlHostname(new URL(page.url));
	if (siteOf(finalHost).site !== siteOf(host).site) return { state: "redirected", detail: `Redirected to ${finalHost} (HTTP ${page.status}).` };

	const detail = `HTTP ${page.status}.`;
	if (page.body !== undefined && !page.body.trim()) {
		// Nothing to judge but the status: an empty answer is a host's, never a kit's page.
		if (page.status === 404 || page.status === 410 || page.status === 451) return { state: "removed", detail };
		if (page.status >= 500) return { state: "unreachable", detail };
	}
	// A bare server's not-found or gateway error page, by what it says: a shared host that deleted the site, or an origin that is down.
	const bare = page.body === undefined ? undefined : classifyBareErrorPage({ html: page.body, headers: page.headers });
	if (bare === "not_found") return { state: "removed", detail };
	if (bare === "server_error") return { state: "unreachable", detail };
	// Any other answer is the site, whatever its status: a login wall, a WAF or bot check, or a kit under a 403, 404 or 500.
	return { state: "online", detail };
}
