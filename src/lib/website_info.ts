import dns from "node:dns/promises";
import { isIP as isIPAddress } from "node:net";
import uniqBy from "lodash/uniqBy";
import uniq from "lodash/uniq";
import { parse } from "tldts";
import { recursiveAbuseContact } from "../web_lib/util";
import { retry } from "./utils";

export async function queryDns(domain: string) {
	const [a, aaaa, ns, mx, cname, txt] = await Promise.allSettled([
		dns.resolve4(domain),
		dns.resolve6(domain),
		dns.resolveNs(domain),
		dns.resolveMx(domain),
		dns.resolveCname(domain),
		dns.resolveTxt(domain),
	]);

	return {
		A: a.status === "fulfilled" ? a.value : [],
		AAAA: aaaa.status === "fulfilled" ? aaaa.value : [],
		NS: ns.status === "fulfilled" ? ns.value : [],
		MX: mx.status === "fulfilled" ? mx.value : [],
		CNAME: cname.status === "fulfilled" ? cname.value : [],
		TXT: txt.status === "fulfilled" ? txt.value.flat() : [],
	};
}

type VCardEntry = [string, Record<string, unknown>, string, string | string[] | string[][]];
type VCardArray = ["vcard", VCardEntry[]];
type RDAPVCard = Record<string, string | string[] | string[][]> & {
	fn?: string;
	org?: string;
	email?: string;
	tel?: string;
};

type RDAPPublicId = {
	type?: string;
	identifier?: string;
};

type RDAPLink = {
	value?: string;
	rel?: string;
	type?: string;
	href?: string;
};

type RDAPEventMap = Record<string, string>;

export type RDAPEntity = {
	remarks: string;
	handle?: string;
	roles: string[];
	links: RDAPLink[];
	publicIds: RDAPPublicId[];
	entities?: RDAPEntity[];
	vcard?: RDAPVCard | null;
};

export type RDAPAbuseContact = RDAPVCard & {
	remarks: string;
};

type RDAPCIDR = {
	v4prefix?: string;
	v6prefix?: string;
	length?: number;
};

export type RDAPAutnumInfo = RDAPEntity & {
	asn: number;
	name?: string;
	startAutnum?: number;
	endAutnum?: number;
	status: string[];
	events: RDAPEventMap;
	abuse: RDAPAbuseContact | null;
};

/** A BGP origin observed for an IP address, enriched with the ASN's RDAP record. */
export type OriginASNInfo = {
	asn: number;
	prefix?: string;
	source: "ripe-stat";
	rdap?: RDAPAutnumInfo;
};

export type RDAPIPInfo = RDAPEntity & {
	startAddress?: string;
	endAddress?: string;
	ipVersion?: string;
	name?: string;
	type?: string;
	country?: string;
	parentHandle?: string;
	cidr0_cidrs: RDAPCIDR[];
	status: string[];
	events: RDAPEventMap;
	port43?: string;
	ip: string;
	abuse: RDAPAbuseContact | null;
	origin_asns: OriginASNInfo[];
};

export type RDAPDomainInfo = {
	domain: string;
	status: string[];
	events: RDAPEventMap;
	nameservers: string[];
	registrar:
		| (RDAPEntity & {
				abuse: RDAPAbuseContact | null;
		  })
		| null;
};

const rdapDomainResolverUrl = "https://rdap.org/domain/";
const rdapIpResolverUrl = "https://rdap.org/ip/";
const rdapAutnumResolverUrl = "https://rdap.org/autnum/";
const ripeStatNetworkInfoUrl = "https://stat.ripe.net/data/network-info/data.json?resource=";
type RDAPFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function getDomainRdapUrl(domain: string) {
	return `${rdapDomainResolverUrl}${encodeURIComponent(domain)}`;
}

export function getIPRdapUrl(ip: string) {
	return `${rdapIpResolverUrl}${encodeURIComponent(ip)}`;
}

export function getAutnumRdapUrl(asn: number) {
	return `${rdapAutnumResolverUrl}${asn}`;
}

export function getRipeStatNetworkInfoUrl(ip: string) {
	return `${ripeStatNetworkInfoUrl}${encodeURIComponent(ip)}`;
}

function parseVCard(vcardArray?: VCardArray): RDAPVCard | null {
	if (!vcardArray || vcardArray[0] !== "vcard") return null;
	const entries = vcardArray[1] ?? [];
	const parsed: RDAPVCard = {};

	for (const entry of entries) {
		const [name, _meta, _type, value] = entry;
		if (!name) continue;
		const existing = parsed[name];
		if (!existing) {
			parsed[name] = value;
		} else if (Array.isArray(existing)) {
			existing.push(value as any);
		} else {
			parsed[name] = [existing, value] as any;
		}
	}

	return parsed;
}

function simplifyEntity(entity: any): RDAPEntity {
	if (!entity) return null as any;
	const entities: RDAPEntity[] | null = entity.entities ? entity.entities.map(simplifyEntity) : null;

	return {
		remarks: (entity.remarks ?? [])
			.map((remark: any) => remark.description ?? [])
			.flat()
			.join("\n")
			.replaceAll(/\r+/g, ""),
		handle: entity.handle,
		roles: entity.roles ?? [],
		links: entity.links ?? [],
		publicIds: entity.publicIds ?? [],
		...(entities
			? {
					entities,
				}
			: {}),
		...(entity.vcardArray
			? {
					vcard: parseVCard(entity.vcardArray),
				}
			: {}),
	};
}

export async function queryRDAPDomain(
	domain: string,
	fetchImplementation: RDAPFetch = fetch,
): Promise<RDAPDomainInfo | undefined> {
	try {
		const response = await retry(() =>
			fetchImplementation(getDomainRdapUrl(domain), {
				method: "GET",
				redirect: "follow",
				headers: {
					Accept: "application/rdap+json",
				},
			})
		);

		if (!response.ok) return;

		const json = await response.json();
		if (!json) return json;

		return simplifyDomainRDAP(json, domain);
	} catch (error) {
		console.error("Error querying RDAP for domain:", domain, error);
		return undefined;
	}
}

function simplifyEvents(events: any): RDAPEventMap {
	return (events ?? []).reduce((acc: Record<string, string>, event: any) => {
		if (event?.eventAction && event?.eventDate) {
			acc[event.eventAction] = event.eventDate;
		}
		return acc;
	}, {});
}

function parseAsn(value: unknown): number | undefined {
	const normalized = String(value).trim().replace(/^AS/i, "");
	if (!/^\d+$/.test(normalized)) return;

	const asn = Number(normalized);
	return Number.isSafeInteger(asn) && asn >= 0 && asn <= 4_294_967_295 ? asn : undefined;
}

export async function queryOriginASNs(ip: string, fetchImplementation: RDAPFetch = fetch): Promise<OriginASNInfo[]> {
	try {
		const response = await retry(() =>
			fetchImplementation(getRipeStatNetworkInfoUrl(ip), {
				method: "GET",
				headers: {
					Accept: "application/json",
				},
			})
		);

		if (!response.ok) return [];

		const json = (await response.json()) as { data?: { asns?: unknown[]; prefix?: unknown } };
		const prefix = typeof json.data?.prefix === "string" ? json.data.prefix : undefined;
		const asns = uniq((json.data?.asns ?? []).map(parseAsn).filter((asn): asn is number => asn !== undefined));

		return asns.map((asn) => ({ asn, prefix, source: "ripe-stat" }));
	} catch (error) {
		console.error("Error querying BGP origin ASN for IP:", ip, error);
		return [];
	}
}

export async function queryRDAPAutnum(asn: number, fetchImplementation: RDAPFetch = fetch): Promise<RDAPAutnumInfo | undefined> {
	try {
		const response = await retry(() =>
			fetchImplementation(getAutnumRdapUrl(asn), {
				method: "GET",
				redirect: "follow",
				headers: {
					Accept: "application/rdap+json",
				},
			})
		);

		if (!response.ok) return;

		const json = await response.json();
		return simplifyAutnum(json, asn);
	} catch (error) {
		console.error("Error querying RDAP for ASN:", asn, error);
		return undefined;
	}
}

export async function queryRDAPIP(ip: string, fetchImplementation: RDAPFetch = fetch): Promise<RDAPIPInfo | undefined> {
	try {
		const [response, origins] = await Promise.all([
			retry(() =>
				fetchImplementation(getIPRdapUrl(ip), {
					method: "GET",
					redirect: "follow",
					headers: {
						Accept: "application/rdap+json",
					},
				})
			),
			queryOriginASNs(ip, fetchImplementation),
		]);

		if (!response.ok) return;

		const json = await response.json();
		const origin_asns = await Promise.all(
			origins.map(async (origin) => ({
				...origin,
				rdap: await queryRDAPAutnum(origin.asn, fetchImplementation),
			}))
		);

		return { ...simplifyIP(json, ip), origin_asns };
	} catch (error) {
		console.error("Error querying RDAP for IP:", ip, error);
		return undefined;
	}
}

function simplifyDomainRDAP(json: any, domain: string): RDAPDomainInfo {
	const registrarEntity = simplifyEntity((json.entities ?? []).find((entity: any) => entity.roles?.includes("registrar")));

	return {
		domain: json.ldhName ?? domain,
		status: json.status ?? [],
		events: simplifyEvents(json.events),
		nameservers: (json.nameservers ?? []).map((nameserver: any) => nameserver.ldhName).filter(Boolean),
		registrar: registrarEntity
			? {
					...registrarEntity,
					abuse: recursiveAbuseContact(registrarEntity),
				}
			: null,
	};
}

function simplifyIP(json: any, ip: string): RDAPIPInfo {
	const simplified = simplifyEntity(json);

	return {
		startAddress: json.startAddress,
		endAddress: json.endAddress,
		ipVersion: json.ipVersion,
		name: json.name,
		type: json.type,
		country: json.country,
		parentHandle: json.parentHandle,
		cidr0_cidrs: json.cidr0_cidrs ?? [],
		status: json.status ?? [],
		events: simplifyEvents(json.events),
		port43: json.port43,
		ip,
		...simplified,
		abuse: recursiveAbuseContact(simplified),
		origin_asns: [],
	};
}

function simplifyAutnum(json: any, asn: number): RDAPAutnumInfo {
	const simplified = simplifyEntity(json);

	return {
		...simplified,
		asn,
		handle: json.handle ?? simplified.handle,
		name: json.name,
		startAutnum: json.startAutnum,
		endAutnum: json.endAutnum,
		status: json.status ?? [],
		events: simplifyEvents(json.events),
		abuse: recursiveAbuseContact(simplified),
	};
}

function isIP(input: string) {
	return isIPAddress(input) !== 0;
}

export type WhoISInfo = {
	rdap?: RDAPDomainInfo;
	dns?: Awaited<ReturnType<typeof queryDns>>;
	nameserver_info?: RDAPDomainInfo[];
	ip_rdaps: RDAPIPInfo[];
	root_info?: WhoISInfo;
};

export async function getInfo(domain_or_ip: string): Promise<WhoISInfo> {
	const target = domain_or_ip.startsWith("http") ? new URL(domain_or_ip).hostname : domain_or_ip;

	if (isIP(target)) {
		const rdap = await queryRDAPIP(target);

		return { ip_rdaps: rdap ? [rdap] : [] };
	}

	const { domain } = parse(target);
	var root_info = undefined as Awaited<ReturnType<typeof getInfo>> | undefined;

	if (domain !== target && domain) {
		// also query root subdomain
		root_info = await getInfo(domain);
	}

	const [rdap, dns_info] = await Promise.all([queryRDAPDomain(domain || target), queryDns(target)]);

	var nameservers = uniq([...dns_info.NS, ...(rdap?.nameservers || [])].map((x) => parse(x).domain).filter(Boolean) as string[]);
	let nameserver_info = undefined as RDAPDomainInfo[] | undefined;

	if (nameservers.length) {
		nameserver_info = (await Promise.allSettled(nameservers.map((nameserver) => queryRDAPDomain(nameserver))))
			.filter((info) => info.status === "fulfilled" && info.value !== null)
			.map((info) => (info as PromiseFulfilledResult<RDAPDomainInfo>).value);
	}

	const ip_addresses = [...dns_info.A, ...dns_info.AAAA];

	const ip_rdaps = uniqBy(
		(await Promise.all(ip_addresses.map((ip) => queryRDAPIP(ip)))).filter((x) => x !== undefined) as RDAPIPInfo[],
		(item) => item.abuse?.email || item.handle
	);

	return {
		rdap,
		dns: dns_info,
		nameserver_info,
		ip_rdaps,
		root_info,
	};
}
