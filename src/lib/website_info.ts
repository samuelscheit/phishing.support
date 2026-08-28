import dns from "node:dns/promises";
import { isIP as isIPAddress } from "node:net";
import uniq from "lodash/uniq";
import uniqBy from "lodash/uniqBy";
import { parse } from "tldts";

import { recursiveAbuseContact } from "../web_lib/util";
import { fetchJson, retryWithTimeout, type FetchImplementation } from "./network/bounded_fetch";
import { resolveRegionalDns, type RegionalDnsDependencies, type RegionalDnsResolution } from "./network/regional_dns";

const LOOKUP_TIMEOUT_MS = 5_000;
const LOOKUP_ATTEMPTS = 2;
const LOOKUP_RETRY_DELAY_MS = 250;
const MAX_NAMESERVER_LOOKUPS = 8;
const MAX_IP_RDAP_LOOKUPS = 16;

type DnsResolver = {
	resolve4(hostname: string): Promise<string[]>;
	resolve6(hostname: string): Promise<string[]>;
	resolveNs(hostname: string): Promise<string[]>;
	resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
	resolveCname(hostname: string): Promise<string[]>;
	resolveTxt(hostname: string): Promise<string[][]>;
};

export type WebsiteInfoDependencies = {
	fetch?: FetchImplementation;
	dns?: DnsResolver;
	timeoutMs?: number;
	retryAttempts?: number;
	retryDelayMs?: number;
	regionalDns?: false | RegionalDnsDependencies;
};

function lookupOptions(dependencies: WebsiteInfoDependencies, label: string) {
	return {
		label,
		timeoutMs: dependencies.timeoutMs ?? LOOKUP_TIMEOUT_MS,
		attempts: dependencies.retryAttempts ?? LOOKUP_ATTEMPTS,
		retryDelayMs: dependencies.retryDelayMs ?? LOOKUP_RETRY_DELAY_MS,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function lookup<T>(operation: () => Promise<T>, dependencies: WebsiteInfoDependencies, label: string): Promise<T> {
	return retryWithTimeout(operation, lookupOptions(dependencies, label));
}

export type DnsLookup = {
	A: string[];
	AAAA: string[];
	NS: string[];
	MX: Array<{ exchange: string; priority: number }>;
	CNAME: string[];
	TXT: string[];
	errors?: Partial<Record<"A" | "AAAA" | "NS" | "MX" | "CNAME" | "TXT", string>>;
	regional?: {
		A: RegionalDnsResolution;
		AAAA: RegionalDnsResolution;
	};
};

type DnsRecordType = "A" | "AAAA" | "NS" | "MX" | "CNAME" | "TXT";

async function settledDnsLookup<T>(
	recordType: DnsRecordType,
	operation: () => Promise<T>,
	dependencies: WebsiteInfoDependencies,
): Promise<{ recordType: DnsRecordType; value: T | undefined; error?: string }> {
	try {
		return { recordType, value: await lookup(operation, dependencies, `DNS ${recordType} lookup`) };
	} catch (error) {
		return { recordType, value: undefined, error: errorMessage(error) };
	}
}

/**
 * Resolve DNS record sets independently and with bounded retries. Partial
 * evidence survives resolver failures, so one unavailable record type cannot
 * block a website analysis.
 */
export async function queryDns(domain: string, dependencies: WebsiteInfoDependencies = {}): Promise<DnsLookup> {
	const resolver = dependencies.dns ?? dns;
	const [a, aaaa, ns, mx, cname, txt] = await Promise.all([
		settledDnsLookup("A", () => resolver.resolve4(domain), dependencies),
		settledDnsLookup("AAAA", () => resolver.resolve6(domain), dependencies),
		settledDnsLookup("NS", () => resolver.resolveNs(domain), dependencies),
		settledDnsLookup("MX", () => resolver.resolveMx(domain), dependencies),
		settledDnsLookup("CNAME", () => resolver.resolveCname(domain), dependencies),
		settledDnsLookup("TXT", () => resolver.resolveTxt(domain), dependencies),
	]);
	const results = { A: a, AAAA: aaaa, NS: ns, MX: mx, CNAME: cname, TXT: txt };
	const errors = Object.fromEntries(
		Object.values(results)
			.filter((result) => result.error)
			.map((result) => [result.recordType, result.error!]),
	) as DnsLookup["errors"];

	const regionalDependencies = dependencies.regionalDns === false ? undefined : dependencies.regionalDns ?? {};
	const [regionalA, regionalAAAA] = regionalDependencies
		? await Promise.all([
			resolveRegionalDns(domain, "A", {
				...regionalDependencies,
				fetch: regionalDependencies.fetch ?? dependencies.fetch,
				timeoutMs: regionalDependencies.timeoutMs ?? dependencies.timeoutMs,
			}),
			resolveRegionalDns(domain, "AAAA", {
				...regionalDependencies,
				fetch: regionalDependencies.fetch ?? dependencies.fetch,
				timeoutMs: regionalDependencies.timeoutMs ?? dependencies.timeoutMs,
			}),
		])
		: [undefined, undefined];
	const regional = regionalA && regionalAAAA ? { A: regionalA, AAAA: regionalAAAA } : undefined;

	return {
		A: a.value ?? [],
		AAAA: aaaa.value ?? [],
		NS: ns.value ?? [],
		MX: mx.value ?? [],
		CNAME: cname.value ?? [],
		TXT: (txt.value ?? []).flat(),
		...(Object.keys(errors ?? {}).length ? { errors } : {}),
		...(regional ? { regional } : {}),
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

type RDAPPublicId = { type?: string; identifier?: string };
type RDAPLink = { value?: string; rel?: string; type?: string; href?: string };
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

export type RDAPAbuseContact = RDAPVCard & { remarks: string };
type RDAPCIDR = { v4prefix?: string; v6prefix?: string; length?: number };

export type RDAPAutnumInfo = RDAPEntity & {
	asn: number;
	name?: string;
	startAutnum?: number;
	endAutnum?: number;
	status: string[];
	events: RDAPEventMap;
	abuse: RDAPAbuseContact | null;
};

export type OriginASNInfo = {
	asn: number;
	prefix?: string;
	source: "ripe-stat";
	rdap?: RDAPAutnumInfo;
	error?: string;
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
	registrar: (RDAPEntity & { abuse: RDAPAbuseContact | null }) | null;
};

const rdapDomainResolverUrl = "https://rdap.org/domain/";
const rdapIpResolverUrl = "https://rdap.org/ip/";
const rdapAutnumResolverUrl = "https://rdap.org/autnum/";
const ripeStatNetworkInfoUrl = "https://stat.ripe.net/data/network-info/data.json?resource=";

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
	const parsed: RDAPVCard = {};
	for (const entry of vcardArray[1] ?? []) {
		const [name, _meta, _type, value] = entry;
		if (!name) continue;
		const existing = parsed[name];
		if (!existing) parsed[name] = value;
		else if (Array.isArray(existing)) existing.push(value as never);
		else parsed[name] = [existing, value] as string[];
	}
	return parsed;
}

function simplifyEntity(entity: unknown): RDAPEntity | undefined {
	if (!entity || typeof entity !== "object") return undefined;
	const source = entity as Record<string, unknown>;
	const entities = Array.isArray(source.entities)
		? source.entities.map(simplifyEntity).filter((value): value is RDAPEntity => Boolean(value))
		: [];
	const remarks = Array.isArray(source.remarks)
		? source.remarks
			.flatMap((remark) => {
				const value = remark && typeof remark === "object" ? (remark as Record<string, unknown>).description : undefined;
				return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
			})
			.join("\n")
			.replaceAll(/\r+/g, "")
		: "";
	return {
		remarks,
		handle: typeof source.handle === "string" ? source.handle : undefined,
		roles: Array.isArray(source.roles) ? source.roles.filter((role): role is string => typeof role === "string") : [],
		links: Array.isArray(source.links) ? source.links.filter((link): link is RDAPLink => Boolean(link) && typeof link === "object") : [],
		publicIds: Array.isArray(source.publicIds) ? source.publicIds.filter((id): id is RDAPPublicId => Boolean(id) && typeof id === "object") : [],
		...(entities.length ? { entities } : {}),
		...(Array.isArray(source.vcardArray) ? { vcard: parseVCard(source.vcardArray as VCardArray) } : {}),
	};
}

function simplifyEvents(events: unknown): RDAPEventMap {
	if (!Array.isArray(events)) return {};
	return events.reduce<RDAPEventMap>((result, event) => {
		if (!event || typeof event !== "object") return result;
		const source = event as Record<string, unknown>;
		if (typeof source.eventAction === "string" && typeof source.eventDate === "string") result[source.eventAction] = source.eventDate;
		return result;
	}, {});
}

function parseAsn(value: unknown): number | undefined {
	const normalized = String(value).trim().replace(/^AS/i, "");
	if (!/^\d+$/.test(normalized)) return;
	const asn = Number(normalized);
	return Number.isSafeInteger(asn) && asn >= 0 && asn <= 4_294_967_295 ? asn : undefined;
}

function requestOptions(dependencies: WebsiteInfoDependencies) {
	return {
		fetch: dependencies.fetch,
		timeoutMs: dependencies.timeoutMs ?? LOOKUP_TIMEOUT_MS,
		attempts: dependencies.retryAttempts ?? LOOKUP_ATTEMPTS,
		retryDelayMs: dependencies.retryDelayMs ?? LOOKUP_RETRY_DELAY_MS,
	};
}

async function fetchRdap(url: string, dependencies: WebsiteInfoDependencies): Promise<Record<string, unknown> | undefined> {
	return fetchJson<Record<string, unknown>>(
		url,
		{
			method: "GET",
			redirect: "follow",
			headers: { Accept: "application/rdap+json" },
		},
		requestOptions(dependencies),
	);
}

function simplifyDomainRDAP(json: Record<string, unknown>, domain: string): RDAPDomainInfo {
	const registrarEntity = Array.isArray(json.entities)
		? json.entities.map(simplifyEntity).find((entity) => entity?.roles.some((role) => role.toLowerCase() === "registrar"))
		: undefined;
	return {
		domain: typeof json.ldhName === "string" ? json.ldhName : domain,
		status: Array.isArray(json.status) ? json.status.filter((status): status is string => typeof status === "string") : [],
		events: simplifyEvents(json.events),
		nameservers: Array.isArray(json.nameservers)
			? json.nameservers.flatMap((nameserver) => {
				const record = nameserver && typeof nameserver === "object" ? nameserver as Record<string, unknown> : undefined;
				return typeof record?.ldhName === "string" ? [record.ldhName] : [];
			})
			: [],
		registrar: registrarEntity ? { ...registrarEntity, abuse: recursiveAbuseContact(registrarEntity) } : null,
	};
}

function simplifyIP(json: Record<string, unknown>, ip: string): RDAPIPInfo {
	const entity = simplifyEntity(json) ?? { remarks: "", roles: [], links: [], publicIds: [] };
	return {
		startAddress: typeof json.startAddress === "string" ? json.startAddress : undefined,
		endAddress: typeof json.endAddress === "string" ? json.endAddress : undefined,
		ipVersion: typeof json.ipVersion === "string" ? json.ipVersion : undefined,
		name: typeof json.name === "string" ? json.name : undefined,
		type: typeof json.type === "string" ? json.type : undefined,
		country: typeof json.country === "string" ? json.country : undefined,
		parentHandle: typeof json.parentHandle === "string" ? json.parentHandle : undefined,
		cidr0_cidrs: Array.isArray(json.cidr0_cidrs) ? json.cidr0_cidrs.filter((cidr): cidr is RDAPCIDR => Boolean(cidr) && typeof cidr === "object") : [],
		status: Array.isArray(json.status) ? json.status.filter((status): status is string => typeof status === "string") : [],
		events: simplifyEvents(json.events),
		port43: typeof json.port43 === "string" ? json.port43 : undefined,
		ip,
		...entity,
		abuse: recursiveAbuseContact(entity),
		origin_asns: [],
	};
}

function simplifyAutnum(json: Record<string, unknown>, asn: number): RDAPAutnumInfo {
	const entity = simplifyEntity(json) ?? { remarks: "", roles: [], links: [], publicIds: [] };
	return {
		...entity,
		asn,
		handle: typeof json.handle === "string" ? json.handle : entity.handle,
		name: typeof json.name === "string" ? json.name : undefined,
		startAutnum: typeof json.startAutnum === "number" ? json.startAutnum : undefined,
		endAutnum: typeof json.endAutnum === "number" ? json.endAutnum : undefined,
		status: Array.isArray(json.status) ? json.status.filter((status): status is string => typeof status === "string") : [],
		events: simplifyEvents(json.events),
		abuse: recursiveAbuseContact(entity),
	};
}

export async function queryRDAPDomain(domain: string, dependencies: WebsiteInfoDependencies = {}): Promise<RDAPDomainInfo | undefined> {
	try {
		const json = await fetchRdap(getDomainRdapUrl(domain), dependencies);
		return json ? simplifyDomainRDAP(json, domain) : undefined;
	} catch (error) {
		console.error("Error querying RDAP for domain:", domain, error);
		return undefined;
	}
}

export async function queryOriginASNs(ip: string, dependencies: WebsiteInfoDependencies = {}): Promise<OriginASNInfo[]> {
	try {
		const json = await fetchJson<{ data?: { asns?: unknown[]; prefix?: unknown } }>(
			getRipeStatNetworkInfoUrl(ip),
			{ method: "GET", headers: { Accept: "application/json" } },
			requestOptions(dependencies),
		);
		const prefix = typeof json?.data?.prefix === "string" ? json.data.prefix : undefined;
		return uniq((json?.data?.asns ?? []).map(parseAsn).filter((asn): asn is number => asn !== undefined)).map((asn) => ({ asn, prefix, source: "ripe-stat" }));
	} catch (error) {
		console.error("Error querying BGP origin ASN for IP:", ip, error);
		return [];
	}
}

export async function queryRDAPAutnum(asn: number, dependencies: WebsiteInfoDependencies = {}): Promise<RDAPAutnumInfo | undefined> {
	try {
		const json = await fetchRdap(getAutnumRdapUrl(asn), dependencies);
		return json ? simplifyAutnum(json, asn) : undefined;
	} catch (error) {
		console.error("Error querying RDAP for ASN:", asn, error);
		return undefined;
	}
}

export async function queryRDAPIP(ip: string, dependencies: WebsiteInfoDependencies = {}): Promise<RDAPIPInfo | undefined> {
	try {
		const [json, origins] = await Promise.all([fetchRdap(getIPRdapUrl(ip), dependencies), queryOriginASNs(ip, dependencies)]);
		if (!json) return undefined;
		const origin_asns = await Promise.all(origins.map(async (origin) => {
			const rdap = await queryRDAPAutnum(origin.asn, dependencies);
			return rdap ? { ...origin, rdap } : origin;
		}));
		return { ...simplifyIP(json, ip), origin_asns };
	} catch (error) {
		console.error("Error querying RDAP for IP:", ip, error);
		return undefined;
	}
}

function isIP(input: string) {
	return isIPAddress(input) !== 0;
}

export type WhoISInfo = {
	rdap?: RDAPDomainInfo;
	dns?: DnsLookup;
	nameserver_info?: RDAPDomainInfo[];
	ip_rdaps: RDAPIPInfo[];
	root_info?: WhoISInfo;
};

function normalizedTarget(domainOrIp: string): string {
	try {
		return new URL(domainOrIp).hostname;
	} catch {
		return domainOrIp.trim().replace(/\.$/, "");
	}
}

/**
 * Gather DNS and RDAP evidence through independently bounded work. A stalled
 * external WHOIS/RDAP endpoint leaves partial evidence but cannot hold the
 * submission at the whois_lookup step.
 */
export async function getInfo(domainOrIp: string, dependencies: WebsiteInfoDependencies = {}): Promise<WhoISInfo> {
	const target = normalizedTarget(domainOrIp);
	if (isIP(target)) {
		const rdap = await queryRDAPIP(target, dependencies);
		return { ip_rdaps: rdap ? [rdap] : [] };
	}

	const { domain } = parse(target);
	const registrableDomain = domain || target;
	const [rdap, dnsInfo, rootInfo] = await Promise.all([
		queryRDAPDomain(registrableDomain, dependencies),
		queryDns(target, dependencies),
		domain && domain !== target ? getInfo(domain, { ...dependencies, regionalDns: false }) : Promise.resolve(undefined),
	]);

	const nameservers = uniq([...dnsInfo.NS, ...(rdap?.nameservers ?? [])]
		.map((nameserver) => parse(nameserver).domain)
		.filter((value): value is string => Boolean(value)))
		.slice(0, MAX_NAMESERVER_LOOKUPS);
	const localIps = uniq([...dnsInfo.A, ...dnsInfo.AAAA]);
	const regionalIps = uniq([...(dnsInfo.regional?.A.resolvedAddresses ?? []), ...(dnsInfo.regional?.AAAA.resolvedAddresses ?? [])])
		.filter((ip) => !localIps.includes(ip));
	const [nameserverInfo, localIpRdaps, regionalIpRdaps] = await Promise.all([
		Promise.all(nameservers.map((nameserver) => queryRDAPDomain(nameserver, dependencies))).then((values) => values.filter((value): value is RDAPDomainInfo => Boolean(value))),
		Promise.all(localIps.slice(0, MAX_IP_RDAP_LOOKUPS).map((ip) => queryRDAPIP(ip, dependencies))),
		Promise.all(regionalIps.slice(0, MAX_IP_RDAP_LOOKUPS).map((ip) => queryRDAPIP(ip, dependencies))),
	]);
	const ipRdaps = uniqBy(
		[...localIpRdaps, ...regionalIpRdaps].filter((value): value is RDAPIPInfo => Boolean(value)),
		(item) => item.ip,
	);

	return {
		rdap,
		dns: dnsInfo,
		nameserver_info: nameserverInfo.length ? nameserverInfo : undefined,
		ip_rdaps: ipRdaps,
		root_info: rootInfo,
	};
}
