import { isIP } from "node:net";

import { isPublicIp } from "../abuse/security/security";
import { cdnOfServer, edgeOfAsn } from "../network/cdn";
import { asHolder, asHolderName, ipNetwork } from "../network/ripestat";
import { asRecord, text } from "../util/values";

/** One address a reported site resolved to, and the network that announces it. */
export type HostingAddress = {
	ip: string;
	/** The announcing AS; absent when the address is not public or the lookup failed. */
	asn?: number;
	/** The AS holder as RIPEstat names it ("Sollutium-NL SOLLUTIUM EU Sp z.o.o."). */
	holder?: string;
	prefix?: string;
	/** The CDN or cloud front end the site is served through, by its network or by the platform that answered: its server may be elsewhere. */
	cdn?: string;
};

/** Where a check found the site served from: its addresses with their networks, and the server its answer named. */
export type SiteHosting = {
	addresses: HostingAddress[];
	/** The HTTP `Server` header of the visit's last answer ("cloudflare", "nginx/1.30.0"). */
	server?: string;
};

/** One side of a move: the network (or CDN) a site was served from, as people name it. */
export type HostingNetwork = {
	/** "Cloudflare" for a CDN, else the AS name ("Sollutium-NL"), else the first address. */
	name: string;
	cdn?: string;
	asn?: number;
	holder?: string;
	addresses: string[];
};

/**
 * A site that changed the network serving it:
 *
 * - `left_cdn`: it was proxied by a CDN and now answers from its own server
 *   (trylevo.app after Cloudflare restricted it, case 384401854580134038).
 * - `new_cdn`: it moved behind a CDN, or from one CDN to another.
 * - `new_network`: its server moved to another network.
 */
export type HostMoveKind = "left_cdn" | "new_cdn" | "new_network";

export type HostingChange = { kind: HostMoveKind; from: HostingNetwork; to: HostingNetwork };

/** Looks up the network of one public address; tests replace it. */
export type NetworkLookup = (ip: string) => Promise<Omit<HostingAddress, "ip" | "cdn">>;

/** RIPEstat's announcing AS, prefix and AS holder of an address. */
const ripeStatNetwork: NetworkLookup = async (ip) => {
	const { asns, prefix } = await ipNetwork(ip);
	const asn = asns[0];
	if (asn === undefined) return prefix ? { prefix } : {};
	const holder = await asHolder(asn).catch(() => undefined);
	return { asn, ...(holder ? { holder } : {}), ...(prefix ? { prefix } : {}) };
};

/**
 * The networks of the addresses a check resolved, and the edge each is
 * served through: the CDN its network is, or the platform the answer named
 * (`Server: Vercel`). An address the previous check already attributed keeps
 * its network without asking again; a private address or a failed lookup
 * stays unattributed.
 */
export async function attributeHosting(hosting: SiteHosting, previous: SiteHosting | null | undefined, lookup: NetworkLookup = ripeStatNetwork): Promise<SiteHosting> {
	const known = new Map((previous?.addresses ?? []).filter((address) => address.asn !== undefined).map(({ cdn: _cdn, ...address }) => [address.ip, address]));
	const platform = cdnOfServer(hosting.server);
	const addresses = await Promise.all(hosting.addresses.map(async ({ ip }): Promise<HostingAddress> => {
		const cached = known.get(ip);
		if (cached) return cached;
		if (!isIP(ip) || !isPublicIp(ip)) return { ip };
		try {
			return { ip, ...await lookup(ip) };
		} catch {
			return { ip };
		}
	}));
	return {
		...hosting,
		addresses: addresses.map((address) => {
			const cdn = edgeOfAsn(address.asn) ?? (address.asn !== undefined ? platform : undefined);
			return cdn ? { ...address, cdn } : address;
		}),
	};
}

/**
 * The hosting a domain target was reported on: the public addresses its
 * resolution found and the network of each (resolver/domain_infrastructure.ts).
 * Undefined for a snapshot without them (an IP target, a target resolved
 * before infrastructure was).
 */
export function routedHosting(resolverSnapshot: Record<string, unknown> | null | undefined): SiteHosting | undefined {
	const resolutions = asRecord(asRecord(resolverSnapshot)?.infrastructure)?.ipResolutions;
	if (!Array.isArray(resolutions)) return undefined;
	const addresses = resolutions.flatMap((entry): HostingAddress[] => {
		const resolution = asRecord(entry);
		const ip = text(resolution?.ip);
		if (!ip) return [];
		const snapshot = asRecord(resolution?.resolverSnapshot);
		const bgp = asRecord(snapshot?.bgpOrigin);
		const asn = Array.isArray(bgp?.asns) ? Number(bgp.asns[0]) : Number.NaN;
		if (!Number.isSafeInteger(asn) || asn <= 0) return [{ ip }];
		const asnRecord = Array.isArray(snapshot?.asnRdap) ? snapshot.asnRdap.map(asRecord).find((record) => Number(record?.asn) === asn) : undefined;
		const holder = text(asRecord(asnRecord?.organization)?.organization) ?? text(asRecord(snapshot?.allocationOwner)?.name);
		const prefix = text(bgp?.prefix);
		const cdn = edgeOfAsn(asn);
		return [{ ip, asn, ...(holder ? { holder } : {}), ...(prefix ? { prefix } : {}), ...(cdn ? { cdn } : {}) }];
	});
	return addresses.length ? { addresses } : undefined;
}

/**
 * The organisation that holds an AS, normalised, so two networks of one
 * company are one host: "CLOUDFLARENET - Cloudflare, Inc., US" and
 * "Cloudflare, Inc." are both `cloudflareinc`.
 */
function holderOrganisation(holder: string | undefined): string | undefined {
	if (!holder) return undefined;
	const trimmed = holder.trim();
	const name = asHolderName(trimmed);
	const rest = name === trimmed ? trimmed : trimmed.slice(name.length).replace(/^\s*-\s*/, "");
	const organisation = rest.replace(/,\s*[A-Z]{2}$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
	return organisation.length >= 3 ? organisation : undefined;
}

/** What a network is known by: its CDN, else its AS, and the organisation holding it. Empty when nothing is known. */
export function networkIdentities(network: Pick<HostingAddress, "cdn" | "asn" | "holder">): string[] {
	const primary = network.cdn ? `cdn:${network.cdn}` : network.asn !== undefined ? `as:${network.asn}` : undefined;
	if (!primary) return [];
	const organisation = network.cdn ? undefined : holderOrganisation(network.holder);
	return [primary, ...(organisation ? [`org:${organisation}`] : [])];
}

/** An address the site resolved to: one seen before is where the site was, whatever its network was known as then. */
export function addressIdentity(ip: string): string {
	return `ip:${ip.toLowerCase()}`;
}

/** Every identity of a hosting's networks, or undefined when any address is unattributed: an unknown network decides nothing. */
export function hostingIdentities(hosting: SiteHosting): Set<string> | undefined {
	const all = hosting.addresses.map(networkIdentities);
	return all.length && all.every((identities) => identities.length > 0) ? new Set(all.flat()) : undefined;
}

/** The networks of a hosting, by the first address's: a site is served from one network at a time. */
export function hostingNetwork(hosting: SiteHosting): HostingNetwork {
	const [first] = hosting.addresses;
	const addresses = hosting.addresses.map(({ ip }) => ip);
	if (!first) return { name: "no address", addresses };
	const name = first.cdn ?? (first.holder ? asHolderName(first.holder) : first.asn !== undefined ? `AS${first.asn}` : first.ip);
	return {
		name,
		...(first.cdn ? { cdn: first.cdn } : {}),
		...(first.asn !== undefined ? { asn: first.asn } : {}),
		...(first.holder ? { holder: first.holder } : {}),
		addresses,
	};
}

/** The identity a hosting is known by (its CDNs and ASes), or undefined when any of its addresses is unattributed. */
export function hostingKey(hosting: SiteHosting): string | undefined {
	const identities = hostingIdentities(hosting);
	return identities && [...identities].filter((identity) => !identity.startsWith("org:")).sort().join("+");
}

/**
 * Whether the site moved to `after`: only to networks none of which served
 * it before (`before`, and every network in `seen`). New addresses in the
 * same network (a CDN's other edge, a renumbered server), another AS of the
 * same organisation, a return to a network or an address seen since the
 * report, and a hosting whose networks are not all known are no move. So a site flapping
 * between two hosts moves once, not on every check.
 */
export function hostingChange(before: SiteHosting, after: SiteHosting, seen: Iterable<string> = []): HostingChange | undefined {
	const was = hostingIdentities(before);
	const now = hostingIdentities(after);
	if (!was || !now) return undefined;
	const known = new Set([...was, ...before.addresses.map(({ ip }) => addressIdentity(ip)), ...seen]);
	if ([...now, ...after.addresses.map(({ ip }) => addressIdentity(ip))].some((identity) => known.has(identity))) return undefined;
	const from = hostingNetwork(before);
	const to = hostingNetwork(after);
	const kind: HostMoveKind = to.cdn ? "new_cdn" : from.cdn ? "left_cdn" : "new_network";
	return { kind, from, to };
}
