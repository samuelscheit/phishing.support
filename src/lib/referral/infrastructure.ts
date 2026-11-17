import dns from "node:dns/promises";

import { retryWithTimeout } from "../network/bounded_fetch";
import { locatedCountry, originAsns, registeredCountry } from "../network/ripestat";
import { registrableDomain } from "../abuse/security";
import type { AbuseProviderRoute } from "../abuse/schema";
import { countryName, countryRoutes, directComplaint, type Bilingual } from "./countries";
import { plural, record, text } from "./format";
import { providerLead, type ProviderLead } from "./provider_leads";

/**
 * The campaign's infrastructure as investigators need it: every provider
 * that holds records about the operator, with its role, the company that
 * holds the records, and the states involved. Three countries are kept
 * apart because they lead to different authorities:
 * - `country`: where the record-holding company sits (where orders go);
 * - `networkCountry`: where the network is registered (RIR delegation);
 * - `serverCountry`: where the server is located (geolocation; never for a CDN).
 */
export type InfrastructureRole = "hosting" | "cdn" | "registrar" | "exfiltration" | "payment" | "provider";

export type InfrastructureNode = {
	role: InfrastructureRole;
	name: string;
	lead?: ProviderLead;
	country?: string;
	networkCountry?: string;
	serverCountry?: string;
	/** The CDN in front of the node, which then holds the records about its origin. */
	via?: string;
	/** For a host Cloudflare named: the domains Cloudflare named it for. */
	hosts?: string[];
	/** For a data collector behind a CDN: the host the CDN named as its origin. */
	originHost?: string;
	/** Server addresses or AS numbers behind the node, as `192.0.2.1` or `AS64500`. */
	resources: string[];
	contacts: string[];
	sites: string[];
};

/** What one takedown route says about the infrastructure, before country lookups. */
export type InfrastructureClaim = Omit<InfrastructureNode, "lead" | "country" | "serverCountry" | "via" | "originHost" | "sites" | "contacts"> & { contact?: string };

/** Services that only warn or block; they hold no records about the operator. */
const NOT_INFRASTRUCTURE = /^(?:netcraft|netcraft_mail|google_safe_browsing|manual_unroutable|historical:)/;
const REGISTRAR_SOURCES = new Set(["domain_rdap", "registrar_rdap"]);
const NETWORK_SOURCES = new Set(["domain_infrastructure_ip", "ip_rdap", "ripe_abuse_c", "manual_backfill"]);
const COUNTRY_CODE = /^[A-Z]{2}$/;

function country(value: unknown): string | undefined {
	const code = text(value)?.toUpperCase();
	return code && COUNTRY_CODE.test(code) ? code : undefined;
}

/** RIPEstat AS holders read "NAME - Organisation, CC". */
function holderCountry(holder: string | undefined): string | undefined {
	return country(holder?.match(/,\s*([A-Za-z]{2})\s*$/)?.[1]);
}

function mailboxDomain(contact: string | undefined): string | undefined {
	return contact?.split("@")[1]?.toLowerCase();
}

/** Registry and Cloudflare texts arrive HTML-escaped ("Subnet &amp; Telecom"). */
function unescaped(value: string | undefined): string | undefined {
	return value?.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" })[entity]!);
}

/** The infrastructure one takedown route was addressed to, or undefined for warning services. */
export function routeInfrastructure(route: Pick<AbuseProviderRoute, "providerRegistryKey" | "providerDisplayName" | "verifiedEmail" | "resolverProvenance" | "resolutionSnapshot">): InfrastructureClaim | undefined {
	const key = route.providerRegistryKey;
	if (NOT_INFRASTRUCTURE.test(key)) return undefined;
	const contact = route.verifiedEmail ?? undefined;
	const snapshot = record(route.resolutionSnapshot);
	const source = text(record(route.resolverProvenance).source);

	if (key === "cloudflare") return { role: "cdn", name: "Cloudflare", resources: [], ...(contact ? { contact } : {}) };

	if (key === "origin-host-email") {
		const label = unescaped(text(snapshot.providerLabel));
		const networks = Array.isArray(snapshot.networks) ? snapshot.networks.map(record) : [];
		const networkCountry = holderCountry(label) ?? networks.map((network) => holderCountry(text(network.holder))).find(Boolean);
		const domain = text(snapshot.originalDomain)?.toLowerCase();
		return {
			role: "hosting",
			name: label ?? unescaped(route.providerDisplayName)!,
			resources: networks.map((network) => network.asn).filter((asn): asn is number => typeof asn === "number").map((asn) => `AS${asn}`),
			...(domain ? { hosts: [domain] } : {}),
			...(networkCountry ? { networkCountry } : {}),
			...(contact ? { contact } : {}),
		};
	}

	if (source && REGISTRAR_SOURCES.has(source)) {
		const identity = record(record(snapshot.registrar).identity);
		return { role: "registrar", name: text(identity.name) ?? route.providerDisplayName, resources: [], ...(contact ? { contact } : {}) };
	}

	if (source === "service_account_registry" || key === "discord_webhook") {
		return { role: "exfiltration", name: route.providerDisplayName, resources: [], ...(contact ? { contact } : {}) };
	}

	if (source && NETWORK_SOURCES.has(source)) {
		const resolution = record(snapshot.ipResolution);
		const ipRdap = record(record(resolution.ipRdap ?? snapshot.ipRdap).data);
		const owner = record(resolution.allocationOwner ?? snapshot.allocationOwner);
		const network = record(snapshot.network);
		const ip = text(snapshot.infrastructureIp) ?? text(resolution.target) ?? (/^[\d.:a-f]+$/i.test(text(snapshot.target) ?? "") ? text(snapshot.target) : undefined);
		const asn = typeof network.asn === "number" ? `AS${network.asn}` : undefined;
		const networkName = text(owner.name) ?? text(network.asName);
		const holder = unescaped(text(network.holder));
		const domain = mailboxDomain(contact);
		const name = holder ?? (domain && networkName ? `${domain} (${networkName})` : domain ?? networkName ?? route.providerDisplayName);
		const networkCountry = country(ipRdap.country);
		return {
			role: "hosting",
			name,
			resources: [ip, asn].filter((value): value is string => Boolean(value)),
			...(networkCountry ? { networkCountry } : {}),
			...(contact ? { contact } : {}),
		};
	}

	return { role: "provider", name: route.providerDisplayName, resources: [], ...(contact ? { contact } : {}) };
}

/** The infrastructure an indicator names: the exfiltration service or the bank behind an IBAN. */
export function indicatorInfrastructure(indicator: { kind: string; value: string; evidence: Record<string, unknown> }): InfrastructureClaim | undefined {
	if (indicator.kind === "exfiltration_backend") {
		if (indicator.evidence.backendKind === "telegram_bot") return { role: "exfiltration", name: "Telegram", resources: [] };
		if (indicator.evidence.backendKind === "discord_webhook") return { role: "exfiltration", name: "Discord", resources: [] };
		const host = indicator.value.replace(/^collector-host:/, "");
		return { role: "exfiltration", name: host, resources: [] };
	}
	if (indicator.kind === "payment_receiver" && indicator.evidence.receiverKind === "iban") {
		const iban = text(indicator.evidence.receiver) ?? indicator.value.replace(/^iban:/, "");
		const bankCountry = country(iban.slice(0, 2));
		return { role: "payment", name: `IBAN ${iban}`, resources: [], ...(bankCountry ? { networkCountry: bankCountry } : {}) };
	}
	return undefined;
}

/** Public network facts the takedown records lack. */
export type NetworkLookup = {
	registered: (resource: string) => Promise<string | undefined>;
	located: (ip: string) => Promise<string | undefined>;
	/** The IPv4 addresses a host name resolves to. */
	resolve: (host: string) => Promise<string[]>;
	/** The AS numbers announcing an IP address. */
	asns: (ip: string) => Promise<number[]>;
};

const lookupCache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, lookup: () => Promise<T>, fallback: T): Promise<T> {
	const hit = lookupCache.get(key);
	if (hit) return hit as Promise<T>;
	// A failed lookup leaves the fact unknown and is asked again next time.
	const pending = lookup().catch(() => {
		lookupCache.delete(key);
		return fallback;
	});
	lookupCache.set(key, pending);
	return pending;
}

/** RIPEstat and DNS, each question asked once per process: these facts change rarely. */
export const PUBLIC_NETWORK_LOOKUP: NetworkLookup = {
	registered: (resource) => cached(`registered:${resource}`, () => registeredCountry(resource), undefined),
	located: (ip) => cached(`located:${ip}`, () => locatedCountry(ip), undefined),
	resolve: (host) => cached(`resolve:${host}`, () => retryWithTimeout(() => dns.resolve4(host), { label: `DNS lookup for ${host}`, timeoutMs: 5_000, attempts: 2, retryDelayMs: 200 }), []),
	asns: (ip) => cached(`asns:${ip}`, () => originAsns(ip), []),
};

const IP = /^(?:\d{1,3}\.){3}\d{1,3}$|:/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** CDNs whose address says nothing about the origin; the CDN holds the records about it. */
const CDN_ASNS: ReadonlyMap<number, string> = new Map([[13335, "Cloudflare"]]);

/** The node name a claim ends up under: the known record holder, else the claim's own name. */
export function claimNodeName(claim: InfrastructureClaim): string {
	return providerLead(claim.name, mailboxDomain(claim.contact))?.holder.en ?? claim.name;
}

/**
 * Which claims name the same provider: a known record holder, else the
 * network's AS (one host, however its name was spelled), else the abuse
 * mailbox's domain, else the name.
 */
function nodeKey(claim: InfrastructureClaim, lead: ProviderLead | undefined): string {
	const identity = lead?.holder.en
		?? claim.resources.find((resource) => resource.startsWith("AS"))
		?? mailboxDomain(claim.contact)
		?? claim.name.toLowerCase();
	return `${claim.role}:${identity}`;
}

/** One node per role and record holder, with the countries the claims themselves carry. */
export function mergeInfrastructure(claims: ReadonlyArray<{ site: string; claim: InfrastructureClaim }>): InfrastructureNode[] {
	const nodes = new Map<string, InfrastructureNode>();
	for (const { site, claim } of claims) {
		const lead = providerLead(claim.name, mailboxDomain(claim.contact));
		const key = nodeKey(claim, lead);
		const node = nodes.get(key) ?? { role: claim.role, name: claimNodeName(claim), ...(lead ? { lead } : {}), resources: [], contacts: [], sites: [] };
		if (!node.networkCountry && claim.networkCountry) node.networkCountry = claim.networkCountry;
		for (const resource of claim.resources) if (!node.resources.includes(resource)) node.resources.push(resource);
		if (claim.hosts?.length) node.hosts = [...new Set([...node.hosts ?? [], ...claim.hosts])];
		if (claim.contact && !node.contacts.includes(claim.contact)) node.contacts.push(claim.contact);
		if (!node.sites.includes(site)) node.sites.push(site);
		const holderCountry = node.lead?.country ?? node.networkCountry;
		if (holderCountry) node.country = holderCountry;
		nodes.set(key, node);
	}
	const roleOrder: InfrastructureRole[] = ["hosting", "exfiltration", "payment", "cdn", "registrar", "provider"];
	return [...nodes.values()]
		.map((node) => ({ ...node, contacts: [...node.contacts].sort() }))
		.sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) || b.sites.length - a.sites.length || a.name.localeCompare(b.name));
}

/** The host Cloudflare named for this host name or for another name of the same domain. */
function disclosedOrigin(host: string, hosts: readonly InfrastructureNode[]): InfrastructureNode | undefined {
	const domain = registrableDomain(host) ?? host;
	return hosts.find((candidate) => candidate.hosts?.some((named) => named === host || (registrableDomain(named) ?? named) === domain));
}

/**
 * A server that receives the entered data is known only by its host name.
 * When Cloudflare already named the host of that domain, the collector's
 * server is there. Otherwise resolve it: behind a CDN its address says
 * nothing about the origin, so the CDN, which knows the origin, becomes the
 * record holder.
 */
async function locateCollector(node: InfrastructureNode, hosts: readonly InfrastructureNode[], lookup: NetworkLookup): Promise<InfrastructureNode> {
	const origin = disclosedOrigin(node.name.toLowerCase(), hosts);
	if (origin) {
		return {
			...node,
			via: "Cloudflare",
			originHost: origin.name,
			...(origin.country ? { country: origin.country } : {}),
			...(origin.networkCountry ? { networkCountry: origin.networkCountry } : {}),
		};
	}
	const ips = (await lookup.resolve(node.name)).slice(0, 4);
	if (!ips.length) return node;
	const cdn = (await lookup.asns(ips[0]!)).map((asn) => CDN_ASNS.get(asn)).find(Boolean);
	const resolved = { ...node, resources: [...new Set([...node.resources, ...ips])] };
	if (!cdn) return locateNode(resolved, lookup);
	const lead = providerLead(cdn);
	return { ...resolved, via: cdn, ...(lead ? { lead, country: lead.country } : {}) };
}

function isCollector(node: InfrastructureNode): boolean {
	return node.role === "exfiltration" && !node.resources.length && HOST.test(node.name);
}

/**
 * Fill in what the takedown records did not say: the network's registered
 * country and, for a host or a data collector not behind a CDN, where its
 * server stands. Data collectors come last, so they can point to the hosts
 * Cloudflare named.
 */
export async function locateInfrastructure(nodes: readonly InfrastructureNode[], lookup: NetworkLookup = PUBLIC_NETWORK_LOOKUP): Promise<InfrastructureNode[]> {
	const located = await Promise.all(nodes.map((node) => (isCollector(node) ? node : locateNode(node, lookup))));
	const hosts = located.filter((node) => node.role === "hosting");
	return Promise.all(located.map((node) => (isCollector(node) ? locateCollector(node, hosts, lookup) : node)));
}

/** The registered country of a node's first resource and, for a server not behind a CDN, its location. */
async function locateNode(node: InfrastructureNode, lookup: NetworkLookup): Promise<InfrastructureNode> {
	const [first] = node.resources;
	const ip = node.resources.find((resource) => IP.test(resource));
	const locatable = (node.role === "hosting" || node.role === "exfiltration") && !node.via && ip;
	const [networkCountry, serverCountry] = await Promise.all([
		node.networkCountry ?? (first ? lookup.registered(first) : undefined),
		locatable ? lookup.located(ip) : undefined,
	]);
	const country = node.lead?.country ?? networkCountry;
	return { ...node, ...(networkCountry ? { networkCountry } : {}), ...(serverCountry ? { serverCountry } : {}), ...(country ? { country } : {}) };
}

type Language = keyof Bilingual;

export const ROLE_LABEL: Readonly<Record<InfrastructureRole, Bilingual>> = {
	hosting: { de: "Hoster", en: "Host" },
	cdn: { de: "CDN/Proxy", en: "CDN/proxy" },
	registrar: { de: "Registrar", en: "Registrar" },
	exfiltration: { de: "Empfänger der Eingaben", en: "Receives the entered data" },
	payment: { de: "Zahlungsempfänger", en: "Payment receiver" },
	provider: { de: "Anbieter", en: "Provider" },
};

const WORDS = {
	de: { site: "Seite", sites: "Seiten", server: "Server in", network: "Netz registriert in", abuse: "Abuse-Kontakt", via: "hinter", origin: "Server laut Cloudflare bei", unknown: "Staat nicht ermittelt", direct: "Eigene Anzeige vor Ort möglich" },
	en: { site: "site", sites: "sites", server: "server in", network: "network registered in", abuse: "abuse contact", via: "behind", origin: "server, as Cloudflare named it, at", unknown: "State not determined", direct: "A complaint of our own is possible there" },
} as const;

/** How a node is named: a collector behind a CDN keeps its own name, followed by the CDN and, if known, the origin's host. */
export function nodeHolder(node: InfrastructureNode, language: Language): string {
	const words = WORDS[language];
	if (node.originHost) return `${node.name} (${words.via} ${node.via}; ${words.origin} ${node.originHost})`;
	if (node.via) return `${node.name} (${words.via} ${node.lead?.holder[language] ?? node.via})`;
	return node.lead?.holder[language] ?? node.name;
}

function nodeLine(node: InfrastructureNode, language: Language): string {
	const words = WORDS[language];
	const holder = nodeHolder(node, language);
	const details = [
		plural(node.sites.length, words.site, words.sites),
		...node.resources.length ? [node.resources.join(", ")] : [],
		...node.serverCountry && node.serverCountry !== node.country ? [`${words.server} ${countryName(node.serverCountry)[language]}`] : [],
		...node.networkCountry && node.networkCountry !== node.country ? [`${words.network} ${countryName(node.networkCountry)[language]}`] : [],
		...node.contacts.length ? [`${words.abuse} ${node.contacts.join(", ")}`] : [],
	];
	const facts = node.lead && !node.via ? ` – ${node.lead.facts[language]}` : "";
	return `  - ${ROLE_LABEL[node.role][language]}: ${holder}${facts} (${details.join("; ")})`;
}

/**
 * The infrastructure grouped by the state whose authorities reach it: per
 * state the instruments that apply, then each provider there. States come in
 * the order of their most important node (hosts first), unknown ones last.
 */
export function infrastructureLines(nodes: readonly InfrastructureNode[], language: Language): string[] {
	const byCountry = new Map<string, InfrastructureNode[]>();
	for (const node of nodes) {
		const key = node.country ?? "";
		byCountry.set(key, [...byCountry.get(key) ?? [], node]);
	}
	const countries = [...byCountry.keys()].sort((a, b) => (a === "" ? 1 : 0) - (b === "" ? 1 : 0));
	const lines: string[] = [];
	for (const code of countries) {
		const members = byCountry.get(code)!;
		if (!code) {
			lines.push(`${WORDS[language].unknown}:`, ...members.map((node) => nodeLine(node, language)));
			continue;
		}
		const complaint = directComplaint(code);
		lines.push(
			`${countryName(code)[language]} (${code}):`,
			...countryRoutes(code).map((route) => `  ${route[language]}`),
			...complaint ? [`  ${WORDS[language].direct}: ${complaint[language]}`] : [],
			...members.map((node) => nodeLine(node, language)),
		);
	}
	return lines;
}
