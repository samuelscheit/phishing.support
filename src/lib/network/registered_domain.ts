import { parse } from "tldts";

import { registrableDomain } from "../abuse/security/security";
import { hasPathTenants } from "../website/info/site";
import { canonicalHost } from "./url";

/**
 * The site a host belongs to: its registrable domain, where a platform's
 * tenant (`kit.pages.dev`) counts as a site of its own, with the platform
 * named. An IP or a name under no public suffix is its own site.
 */
export function siteOf(hostname: string): { site: string; platform?: string } {
	const host = canonicalHost(hostname);
	const parsed = parse(host, { allowPrivateDomains: true });
	if (parsed.isIp || !parsed.domain) return { site: host };
	return parsed.isPrivate && parsed.publicSuffix ? { site: parsed.domain, platform: parsed.publicSuffix } : { site: parsed.domain };
}

/**
 * Which registration answers for a host. A registry holds only registered
 * domains (`.vip`'s RDAP answers 404 for trustwallet.com-info.vip and names
 * West263 for com-info.vip), so a host is looked up by its registered domain.
 * A platform's tenant (kit.github.io, bucket.s3.amazonaws.com, a
 * sites.google.com site) is the tenant's site: the platform's registration
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
