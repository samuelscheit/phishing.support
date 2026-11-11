import { getDomain } from "tldts";
import { z } from "zod";

import { fetchJson, fetchText, type FetchImplementation } from "../../network/bounded_fetch";
import { hasPathTenants } from "../../website_site";
import { normalizeDomain } from "../security";

/**
 * The Tranco research list ranks registrable domains by popularity across
 * several traffic sources (CrUX, Cloudflare Radar, Umbrella, Majestic,
 * Farsight). A clone kit copies the real site's own files, so an exact-hash
 * search finds the brand it impersonates (x.com for an X clone) next to its
 * siblings. A site this popular is that brand, not one operator's kit.
 */
const TRANCO_LATEST_LIST_URL = "https://tranco-list.eu/api/lists/date/latest";
const trancoDownloadUrl = (listId: string, count: number) => `https://tranco-list.eu/download/${encodeURIComponent(listId)}/${count}`;
/** Deep enough for regional banks and carriers that clones copy; a kit on a hijacked site this popular is rare. */
export const POPULAR_DOMAIN_COUNT = 100_000;
/** Tranco publishes one list a day. */
const POPULAR_DOMAINS_TTL_MS = 24 * 60 * 60_000;
/** 100,000 `rank,domain` lines are about 2 MB. */
const MAX_LIST_BYTES = 8 * 1024 * 1024;

const latestListSchema = z.object({ list_id: z.string().regex(/^[A-Z0-9]{1,16}$/), available: z.boolean() }).passthrough();

export type PopularDomains = ReadonlySet<string>;
export type PopularDomainsDependencies = { fetch?: FetchImplementation; now?: () => number };

let cached: { loadedAt: number; domains: Promise<PopularDomains> } | undefined;

async function downloadPopularDomains(dependencies: PopularDomainsDependencies): Promise<PopularDomains> {
	const options = { fetch: dependencies.fetch, timeoutMs: 30_000, attempts: 2, retryDelayMs: 1_000 };
	const latest = latestListSchema.safeParse(await fetchJson(TRANCO_LATEST_LIST_URL, { headers: { Accept: "application/json" } }, options));
	if (!latest.success || !latest.data.available) throw new Error("Tranco did not name an available latest list.");
	const csv = await fetchText(trancoDownloadUrl(latest.data.list_id, POPULAR_DOMAIN_COUNT), { headers: { Accept: "text/csv" } }, { ...options, maxResponseBytes: MAX_LIST_BYTES });
	const domains = new Set<string>();
	for (const line of csv?.split("\n") ?? []) {
		const domain = normalizeDomain(line.slice(line.indexOf(",") + 1).trim());
		if (domain) domains.add(domain);
	}
	// A truncated or empty answer would quietly let every brand back in.
	if (domains.size < POPULAR_DOMAIN_COUNT / 2) throw new Error(`Tranco list ${latest.data.list_id} held only ${domains.size} domains.`);
	return domains;
}

/** The Tranco top list, downloaded once a day and shared by every caller; a failed download is retried by the next caller. */
export function loadPopularDomains(dependencies: PopularDomainsDependencies = {}): Promise<PopularDomains> {
	const now = (dependencies.now ?? Date.now)();
	if (cached && now - cached.loadedAt < POPULAR_DOMAINS_TTL_MS) return cached.domains;
	const entry = { loadedAt: now, domains: downloadPopularDomains(dependencies) };
	cached = entry;
	entry.domains.catch(() => {
		if (cached === entry) cached = undefined;
	});
	return entry.domains;
}

/** Forget the downloaded list; a test seam. */
export function resetPopularDomains(): void {
	cached = undefined;
}

/**
 * Whether a host belongs to a top-ranked site. Tranco ranks registrable
 * domains under the public suffix list's ICANN section, so a platform such as
 * workers.dev or dpdns.org is ranked as a whole; each tenant
 * (`kit.workers.dev`) is its own site and is judged on its own name. A shared
 * host whose tenants sit under a path (sites.google.com) never counts: the
 * tenant, not the host, is the site.
 */
export function isPopularSite(hostname: string, popular: PopularDomains): boolean {
	const host = normalizeDomain(hostname);
	if (!host || hasPathTenants(host)) return false;
	const site = getDomain(host, { allowPrivateDomains: true });
	return Boolean(site && popular.has(site));
}
