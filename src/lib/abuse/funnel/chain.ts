import type { WebsiteNavigationHop } from "../../website/types";
import type { PageScreenshot } from "../linked_host_report";
import { getPublicSuffix } from "tldts";

import { hostRegistration } from "../../network/registered_domain";
import { canonicalHost } from "../../network/url";
import { hasPathTenants } from "../../website/info/site";

function platformTenantOf(host: string): string | undefined {
	const registration = hostRegistration(host);
	return registration && "platformTenant" in registration ? registration.platformTenant : undefined;
}

/**
 * One navigation response of a case's chain, as the visit recorded it; `at`
 * is when the response arrived, when the visit timed it.
 */
export type FunnelHop = Pick<WebsiteNavigationHop, "index" | "url" | "hostname" | "status" | "redirectTo"> & { at?: Date };

/** A page the chain showed: the hop that served it, its visible text and its (stamped) screenshot. */
export type FunnelPage = {
	hopIndex: number;
	url: string;
	title?: string;
	text: string;
	screenshot?: PageScreenshot;
	capturedAt: Date;
};

/** Everything one case recorded of a redirect chain, in navigation order. */
export type FunnelChain = {
	hops: readonly FunnelHop[];
	pages: readonly FunnelPage[];
	startedAt: Date;
};

/**
 * The business a host belongs to: its registrable domain
 * (`www.zatos.com` → `zatos.com`), or on a platform that hosts tenants
 * (the public suffix list's private section, `store1.myshopify.com`) the
 * tenant, never the platform owner.
 */
export function businessSite(hostname: string): string {
	const host = canonicalHost(hostname);
	const registration = hostRegistration(host);
	if (!registration) return host;
	return "platformTenant" in registration ? registration.platformTenant : registration.domain;
}

/** The site is a platform's tenant: the platform's own records (its RDAP, its security.txt) are not the tenant's. */
export function isPlatformTenant(site: string): boolean {
	return platformTenantOf(site) === site && !hasPathTenants(site);
}

/**
 * A host that is a platform itself rather than one business: a host whose
 * tenants sit under a path (`sites.google.com`), or a private suffix of the
 * public suffix list (`myshopify.com`, `pages.dev`). It never is a party.
 */
export function isPlatformHost(hostname: string): boolean {
	const host = canonicalHost(hostname);
	return hasPathTenants(host) || getPublicSuffix(host, { allowPrivateDomains: true }) === host;
}

export function parsedUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}
