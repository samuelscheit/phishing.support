import { isIP } from "node:net";

import { isPublicIp } from "../abuse/security/security";
import { cdnOfAsn } from "../network/cdn";
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
	/** The CDN whose network it is: the site is proxied, its server is elsewhere. */
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
 * The networks of the addresses a check resolved. An address the previous
 * check already attributed keeps that attribution without asking again; a
 * private address or a failed lookup stays unattributed.
 */
export async function attributeAddresses(addresses: readonly string[], previous: SiteHosting | null | undefined, lookup: NetworkLookup = ripeStatNetwork): Promise<HostingAddress[]> {
	const known = new Map((previous?.addresses ?? []).filter((address) => address.asn !== undefined).map((address) => [address.ip, address]));
	return Promise.all(addresses.map(async (ip): Promise<HostingAddress> => {
		const cached = known.get(ip);
		if (cached) return cached;
		if (!isIP(ip) || !isPublicIp(ip)) return { ip };
		try {
			const network = await lookup(ip);
			const cdn = cdnOfAsn(network.asn);
			return { ip, ...network, ...(cdn ? { cdn } : {}) };
		} catch {
			return { ip };
		}
	}));
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
		const cdn = cdnOfAsn(asn);
		return [{ ip, asn, ...(holder ? { holder } : {}), ...(prefix ? { prefix } : {}), ...(cdn ? { cdn } : {}) }];
	});
	return addresses.length ? { addresses } : undefined;
}

/** What one address is served by: its CDN, else its network; undefined when not known. */
function identityOf(address: HostingAddress): string | undefined {
	if (address.cdn) return `cdn:${address.cdn}`;
	return address.asn === undefined ? undefined : `as:${address.asn}`;
}

/** The identities of every address, or undefined when any address is unattributed: an unknown network decides nothing. */
function identities(hosting: SiteHosting): Set<string> | undefined {
	const all = hosting.addresses.map(identityOf);
	return all.length && all.every((identity): identity is string => identity !== undefined) ? new Set(all) : undefined;
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

/** The identity a hosting is known by, for telling one move from another. */
export function hostingKey(hosting: SiteHosting): string | undefined {
	const set = identities(hosting);
	return set && [...set].sort().join("+");
}

/**
 * Whether the site moved between two hostings: only when no network of the
 * new one served it before. New addresses in the same network (a CDN's other
 * edge, a host renumbering its server) are no move, and neither is a hosting
 * whose networks are not all known.
 */
export function hostingChange(before: SiteHosting, after: SiteHosting): HostingChange | undefined {
	const was = identities(before);
	const now = identities(after);
	if (!was || !now || [...now].some((identity) => was.has(identity))) return undefined;
	const from = hostingNetwork(before);
	const to = hostingNetwork(after);
	const kind: HostMoveKind = to.cdn ? "new_cdn" : from.cdn ? "left_cdn" : "new_network";
	return { kind, from, to };
}
