import { parse } from "tldts";

import { registrableDomain } from "../abuse/security/security";
import { hasPathTenants } from "../website/info/site";
import { canonicalHost } from "./url";

/**
 * Platforms whose customers' sites are hosts under the platform's own domain
 * but which the public suffix list's private section does not name. Their
 * registrar holds the platform's domain, never a customer's site. Add one
 * when a reported host turns out to be such a tenant.
 */
const UNLISTED_PLATFORMS = [
	// Site builders and blog hosts.
	"flazio.online", // 21 reported hosts by 2026-11-24 (microsoftoutlook.flazio.online, …)
	"weebly.com",
	"weeblysite.com",
	"godaddysites.com",
	"jimdosite.com",
	"mystrikingly.com",
	"wordpress.com",
	"site123.me",
	"tilda.ws",
	"ukit.me",
	"webnode.page",
	"glitch.me",
	// Hosting: Host.it's free development sites (<site>.sviluppo.host), Contabo's object storage endpoints.
	"sviluppo.host",
	"contabostorage.com",
	// Microsoft 365 tenants' SharePoint and OneDrive.
	"sharepoint.com",
	// SendGrid's per-customer click-tracking hosts (u<id>.ct.sendgrid.net).
	"ct.sendgrid.net",
];

/**
 * The site a host belongs to: its registrable domain, where a platform's
 * tenant (`kit.pages.dev`, `kit.weebly.com`) counts as a site of its own,
 * with the platform named. An IP or a name under no public suffix is its own site.
 */
export function siteOf(hostname: string): { site: string; platform?: string } {
	const host = canonicalHost(hostname);
	const unlisted = UNLISTED_PLATFORMS.find((platform) => host.endsWith(`.${platform}`));
	if (unlisted) return { site: `${host.slice(0, -unlisted.length - 1).split(".").pop()}.${unlisted}`, platform: unlisted };
	const parsed = parse(host, { allowPrivateDomains: true });
	if (parsed.isIp || !parsed.domain) return { site: host };
	return parsed.isPrivate && parsed.publicSuffix ? { site: parsed.domain, platform: parsed.publicSuffix } : { site: parsed.domain };
}

/**
 * Which registration answers for a host. A registry holds only registered
 * domains (`.vip`'s RDAP answers 404 for trustwallet.com-info.vip and names
 * West263 for com-info.vip), so a host is looked up by its registered domain.
 * A platform's tenant (kit.github.io, bucket.s3.amazonaws.com, kit.weebly.com,
 * a sites.google.com site) is the tenant's site: the platform's registration
 * says nothing about who made it, and its registrar never takes it down.
 */
export type HostRegistration = { domain: string } | { platformTenant: string };

/** Undefined for an IP or a name under no public suffix. */
export function hostRegistration(hostname: string): HostRegistration | undefined {
	const host = canonicalHost(hostname);
	if (hasPathTenants(host)) return { platformTenant: host };
	const domain = registrableDomain(host);
	if (!domain) return undefined;
	const { site, platform } = siteOf(host);
	return platform ? { platformTenant: site } : { domain };
}
