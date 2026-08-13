import dns from "node:dns/promises";
import net from "node:net";
import { isIP } from "node:net";

import type { ResolvedRouteInput } from "./repository";
import {
	getProviderForRegistrarId,
	gnameServiceIdentity,
	isGenericEmailRouteEnabled,
	isProviderRouteEnabled,
	verifiedDomainsForEmailRoute,
} from "./registry";
import { AbuseInputError, assertPublicDnsHost, isPublicIp, normalizeDomain, sha256Hex } from "./security";

const RDAP_DOMAIN_URL = "https://rdap.org/domain/";
const RDAP_IP_URL = "https://rdap.org/ip/";
const RDAP_AUTNUM_URL = "https://rdap.org/autnum/";
const RIPE_NETWORK_INFO_URL = "https://stat.ripe.net/data/network-info/data.json?resource=";
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_WHOIS_BYTES = 1024 * 1024;
const WHOIS_TIMEOUT_MS = 12_000;

type JsonRecord = Record<string, unknown>;
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ResolverDependencies = {
	/** Injectable for deterministic resolver tests. Production uses global fetch. */
	fetch?: FetchImplementation;
	/** Injectable because authoritative port-43 services cannot be used in unit tests. */
	port43Query?: (server: string, query: string) => Promise<string>;
	/** Injectable SSRF guard for deterministic tests. Production resolves every host. */
	assertPublicHost?: (hostname: string) => Promise<void>;
};

export type ResolverTarget = {
	normalizedTarget: string;
	targetType: "domain" | "ip";
	observedUrls: string[];
};

export type ResolvedAbuseTarget = {
	status: "resolved" | "no_route" | "failed";
	disposition?: string;
	resolverSnapshot: JsonRecord;
	routes: ResolvedRouteInput[];
};

type AbuseMailbox = {
	email: string;
	source: "domain_rdap" | "domain_whois" | "ip_rdap" | "ip_whois" | "asn_rdap";
	entityHandle?: string;
	entityName?: string;
	roles?: string[];
};

function asRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalizeMailbox(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const candidate = value.trim().replace(/^<|>$/g, "").toLowerCase();
	if (candidate.length > 320) return undefined;
	if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(candidate)) {
		return undefined;
	}
	return candidate;
}

function vcardValues(entity: JsonRecord): JsonRecord {
	const card = asArray(entity.vcardArray);
	if (card[0] !== "vcard" || !Array.isArray(card[1])) return {};
	const result: JsonRecord = {};
	for (const item of card[1] as unknown[]) {
		const entry = asArray(item);
		const key = text(entry[0])?.toLowerCase();
		if (!key) continue;
		const value = entry[3];
		const existing = result[key];
		if (existing === undefined) result[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else result[key] = [existing, value];
	}
	return result;
}

function scalarStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => scalarStrings(item));
}

function entityRoles(entity: JsonRecord): string[] {
	return asArray(entity.roles)
		.map((role) => text(role)?.toLowerCase())
		.filter((role): role is string => Boolean(role));
}

function entityDisplayName(entity: JsonRecord): string | undefined {
	const card = vcardValues(entity);
	return text(card.fn) ?? text(card.org) ?? text(entity.name) ?? text(entity.handle);
}

/**
 * Only an entity that explicitly identifies itself with the RDAP `abuse` role
 * can yield a mailbox. Recursive traversal is necessary because registrars and
 * RIRs commonly nest that entity below an organizational entity. We never
 * promote a technical/admin/billing/registrant contact merely because it is
 * nearby in the RDAP response.
 */
function explicitAbuseMailboxes(entity: unknown, source: AbuseMailbox["source"]): AbuseMailbox[] {
	const record = asRecord(entity);
	if (!record) return [];
	const result: AbuseMailbox[] = [];
	const roles = entityRoles(record);
	if (roles.includes("abuse")) {
		const card = vcardValues(record);
		const emails = uniqueStrings([...scalarStrings(card.email), ...scalarStrings(record.email)].map((value) => normalizeMailbox(value)));
		for (const email of emails) {
			result.push({
				email,
				source,
				entityHandle: text(record.handle),
				entityName: entityDisplayName(record),
				roles,
			});
		}
	}
	for (const child of asArray(record.entities)) result.push(...explicitAbuseMailboxes(child, source));
	return result;
}

function firstEntityWithRole(root: unknown, role: string): JsonRecord | undefined {
	const record = asRecord(root);
	if (!record) return undefined;
	if (entityRoles(record).includes(role)) return record;
	for (const child of asArray(record.entities)) {
		const found = firstEntityWithRole(child, role);
		if (found) return found;
	}
	return undefined;
}

function entityOrganization(entity: unknown): JsonRecord | undefined {
	const record = asRecord(entity);
	if (!record) return undefined;
	const card = vcardValues(record);
	const name = entityDisplayName(record);
	const organization = text(card.org) ?? name;
	return organization || text(record.handle)
		? {
			handle: text(record.handle),
			name,
			organization,
			roles: entityRoles(record),
		}
		: undefined;
}

/** Extract an IANA registrar ID only from a registrar entity's explicit identifiers. */
export function extractRegistrarIdFromRdap(registrar: unknown): number | undefined {
	const record = asRecord(registrar);
	if (!record) return undefined;
	for (const publicId of asArray(record.publicIds)) {
		const value = asRecord(publicId);
		const type = text(value?.type)?.toLowerCase();
		const identifier = text(value?.identifier);
		if (!type || !identifier || !/iana\s+registrar/i.test(type) || !/^\d{1,8}$/.test(identifier)) continue;
		const id = Number(identifier);
		if (Number.isSafeInteger(id)) return id;
	}

	// A few authoritative RDAP responses use a normalized `IANA-1234` handle.
	// Do not parse display names or arbitrary strings: provider selection must stay exact.
	const handle = text(record.handle);
	const matched = handle?.match(/^IANA[-_ ]?(\d{1,8})$/i);
	if (!matched) return undefined;
	const id = Number(matched[1]);
	return Number.isSafeInteger(id) ? id : undefined;
}

function extractPort43(record: JsonRecord | undefined): string | undefined {
	const server = text(record?.port43)?.replace(/\.$/, "");
	if (!server || server.includes(":")) return undefined;
	if (isIP(server)) return isPublicIp(server) ? server : undefined;
	return normalizeDomain(server);
}

function extractWhoisValues(raw: string, labels: RegExp[]): string[] {
	const values: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		for (const label of labels) {
			const matched = line.match(label);
			if (!matched?.[1]) continue;
			values.push(matched[1].trim());
			break;
		}
	}
	return values;
}

/**
 * Port-43 data is intentionally parsed narrowly. An arbitrary `email:` field
 * is not an abuse contact; only a field whose label explicitly says abuse is
 * eligible for an external recipient.
 */
export function parseExplicitWhoisAbuseMailboxes(raw: string): string[] {
	const labels = [
		/^\s*abuse-mailbox\s*:\s*(.+?)\s*$/i,
		/^\s*abuse(?:\s+(?:contact\s+)?)?(?:e-?mail|email)\s*:\s*(.+?)\s*$/i,
		/^\s*registrar\s+abuse\s+contact\s+(?:e-?mail|email)\s*:\s*(.+?)\s*$/i,
	];
	const values = extractWhoisValues(raw, labels).flatMap((value) => value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
	return uniqueStrings(values.map((value) => normalizeMailbox(value)));
}

function parseWhoisNetworkMetadata(raw: string): JsonRecord {
	const first = (labels: RegExp[]) => extractWhoisValues(raw, labels)[0];
	return {
		netname: first([/^\s*netname\s*:\s*(.+?)\s*$/i]),
		descriptions: extractWhoisValues(raw, [/^\s*(?:descr|description)\s*:\s*(.+?)\s*$/i]).slice(0, 30),
		organization: first([/^\s*(?:org(?:anisation|anization)?|owner)\s*:\s*(.+?)\s*$/i]),
	};
}

function responseError(url: URL, response: Response): Error {
	return new Error(`Resolver request to ${url.hostname} failed with HTTP ${response.status}.`);
}

async function responseJson(response: Response, url: URL): Promise<JsonRecord | undefined> {
	if (response.status === 404) return undefined;
	if (!response.ok) throw responseError(url, response);
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) throw new Error("Resolver response exceeded its size limit.");
	const body = Buffer.from(await response.arrayBuffer());
	if (body.byteLength > MAX_JSON_BYTES) throw new Error("Resolver response exceeded its size limit.");
	try {
		return asRecord(JSON.parse(body.toString("utf8")));
	} catch {
		throw new Error(`Resolver response from ${url.hostname} was not valid JSON.`);
	}
}

async function safeJsonFetch(urlValue: string, dependencies: ResolverDependencies): Promise<JsonRecord | undefined> {
	const fetchImplementation = dependencies.fetch ?? fetch;
	const assertHost = dependencies.assertPublicHost ?? assertPublicDnsHost;
	let url = new URL(urlValue);
	for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
		if (url.protocol !== "https:" || url.username || url.password || url.port) {
			throw new AbuseInputError("Resolver attempted an unsafe RDAP endpoint.");
		}
		await assertHost(url.hostname);
		const response = await fetchImplementation(url, {
			method: "GET",
			redirect: "manual",
			headers: { Accept: "application/rdap+json, application/json;q=0.9" },
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error("Resolver received a redirect without a location.");
			url = new URL(location, url);
			continue;
		}
		return responseJson(response, url);
	}
	throw new Error("Resolver exceeded its redirect limit.");
}

async function defaultPort43Query(server: string, query: string): Promise<string> {
	if (!/^[a-z0-9.-]+$/i.test(server) || !/^[a-z0-9:.\-]+$/i.test(query)) {
		throw new AbuseInputError("WHOIS request did not satisfy the strict resolver contract.");
	}

	const addresses = isIP(server)
		? [{ address: server, family: isIP(server) }]
		: await dns.lookup(server, { all: true, verbatim: true });
	const publicAddresses = addresses.filter((address) => isPublicIp(address.address));
	if (publicAddresses.length === 0) throw new AbuseInputError("WHOIS server resolves to a non-public address.");

	let lastError: unknown;
	for (const address of publicAddresses) {
		try {
			return await new Promise<string>((resolve, reject) => {
				const socket = net.createConnection({ host: address.address, port: 43, family: address.family });
				const chunks: Buffer[] = [];
				let size = 0;
				const fail = (error: Error) => {
					socket.destroy();
					reject(error);
				};
				socket.setTimeout(WHOIS_TIMEOUT_MS, () => fail(new Error("WHOIS query timed out.")));
				socket.once("error", reject);
				socket.once("connect", () => socket.write(`${query}\r\n`, "utf8"));
				socket.on("data", (chunk: Buffer) => {
					size += chunk.byteLength;
					if (size > MAX_WHOIS_BYTES) {
						fail(new Error("WHOIS response exceeded its size limit."));
						return;
					}
					chunks.push(Buffer.from(chunk));
				});
				socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			});
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Unable to query the authoritative WHOIS server.");
}

async function queryPort43(server: string | undefined, query: string, dependencies: ResolverDependencies): Promise<{ raw?: string; error?: string }> {
	if (!server) return {};
	try {
		const assertHost = dependencies.assertPublicHost ?? assertPublicDnsHost;
		await assertHost(server);
		const raw = await (dependencies.port43Query ?? defaultPort43Query)(server, query);
		if (Buffer.byteLength(raw) > MAX_WHOIS_BYTES) throw new Error("WHOIS response exceeded its size limit.");
		return { raw };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function dedupeMailboxes(mailboxes: AbuseMailbox[]): AbuseMailbox[] {
	const byEmail = new Map<string, AbuseMailbox>();
	for (const mailbox of mailboxes) if (!byEmail.has(mailbox.email)) byEmail.set(mailbox.email, mailbox);
	return [...byEmail.values()];
}

function emailRoute(params: {
	email: string;
	providerName: string;
	provenance: JsonRecord;
	snapshot: JsonRecord;
}): ResolvedRouteInput {
	const domain = params.email.slice(params.email.lastIndexOf("@") + 1);
	const enabled = isGenericEmailRouteEnabled();
	return {
		routeKey: `email:${params.email}`,
		providerRegistryKey: `email:${domain}`,
		providerDisplayName: params.providerName,
		routeType: "email",
		verifiedEmail: params.email,
		resolverProvenance: params.provenance,
		resolutionSnapshot: params.snapshot,
		verificationResult: {
			verified: enabled,
			verifiedDomains: verifiedDomainsForEmailRoute(params.email),
			...(enabled ? {} : { reason: "generic_email_route_disabled" }),
		},
		status: enabled ? "verified" : "no_route",
	};
}

function unroutableRoute(reason: string, snapshot: JsonRecord, status: "no_route" | "failed" = "no_route"): ResolvedRouteInput {
	return {
		routeKey: "manual_unroutable",
		providerRegistryKey: "manual_unroutable",
		providerDisplayName: "No verified abuse route",
		routeType: "manual_unroutable",
		resolverProvenance: { reason },
		resolutionSnapshot: snapshot,
		status,
	};
}

function gnameRoute(registrarId: number, snapshot: JsonRecord): ResolvedRouteInput {
	const definition = getProviderForRegistrarId(registrarId)!;
	const enabled = isProviderRouteEnabled(definition);
	const identity = gnameServiceIdentity();
	return {
		routeKey: definition.key,
		providerRegistryKey: definition.key,
		providerDisplayName: definition.displayName,
		routeType: "skyvern_portal",
		providerDefinitionVersion: definition.version,
		providerDefinitionHash: definition.contentHash,
		resolverProvenance: { registrarId, match: "exact_iana_registrar_id" },
		resolutionSnapshot: snapshot,
		serviceIdentity: { name: identity.name, mailbox: identity.mailbox, verified: identity.verified },
		status: enabled ? "resolving" : "no_route",
		verificationResult: enabled ? undefined : { verified: false, reason: "provider_route_disabled_or_unproven" },
	};
}

async function resolveDomainTarget(target: ResolverTarget, dependencies: ResolverDependencies): Promise<ResolvedAbuseTarget> {
	const rdapUrl = `${RDAP_DOMAIN_URL}${encodeURIComponent(target.normalizedTarget)}`;
	let rdap: JsonRecord | undefined;
	try {
		rdap = await safeJsonFetch(rdapUrl, dependencies);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const snapshot = { target: target.normalizedTarget, domainRdap: { error: message } };
		return { status: "failed", disposition: "resolver_failed", resolverSnapshot: snapshot, routes: [unroutableRoute("resolver_failed", snapshot, "failed")] };
	}

	if (!rdap) {
		const snapshot = { target: target.normalizedTarget, domainRdap: { result: "not_found" } };
		return { status: "no_route", disposition: "no_verified_abuse_contact", resolverSnapshot: snapshot, routes: [unroutableRoute("no_verified_abuse_contact", snapshot)] };
	}

	// Registry responses frequently wrap the registrar below a top-level
	// organizational entity.  Search the complete RDAP entity tree while still
	// requiring the explicit `registrar` role; display names are never routing
	// input.
	const registrar = firstEntityWithRole(rdap, "registrar");
	const registrarId = extractRegistrarIdFromRdap(registrar);
	const rdapContacts = dedupeMailboxes(explicitAbuseMailboxes(registrar, "domain_rdap"));
	const port43 = extractPort43(rdap);
	const whois = rdapContacts.length === 0 ? await queryPort43(port43, target.normalizedTarget, dependencies) : {};
	const whoisContacts = dedupeMailboxes(
		(whois.raw ? parseExplicitWhoisAbuseMailboxes(whois.raw) : []).map((email) => ({ email, source: "domain_whois" as const })),
	);
	const contacts = rdapContacts.length > 0 ? rdapContacts : whoisContacts;
	const snapshot: JsonRecord = {
		target: target.normalizedTarget,
		registrar: {
			id: registrarId,
			identity: entityOrganization(registrar),
			explicitAbuseMailboxes: rdapContacts,
		},
		domainRdap: rdap,
		port43Whois: {
			server: port43,
			sha256: whois.raw ? sha256Hex(whois.raw) : undefined,
			explicitAbuseMailboxes: whoisContacts,
			networkMetadata: whois.raw ? parseWhoisNetworkMetadata(whois.raw) : undefined,
			error: whois.error,
		},
	};

	const provider = getProviderForRegistrarId(registrarId);
	if (provider?.key === "gname") {
		const route = gnameRoute(registrarId!, snapshot);
		return {
			status: route.status === "no_route" ? "no_route" : "resolved",
			disposition: route.status === "no_route" ? "provider_route_disabled_or_unproven" : undefined,
			resolverSnapshot: snapshot,
			routes: [route],
		};
	}

	if (contacts.length === 0) {
		return { status: "no_route", disposition: "no_verified_abuse_contact", resolverSnapshot: snapshot, routes: [unroutableRoute("no_verified_abuse_contact", snapshot)] };
	}

	return {
		status: "resolved",
		resolverSnapshot: snapshot,
		routes: contacts.map((contact) =>
			emailRoute({
				email: contact.email,
				providerName: contact.entityName ?? `Abuse contact for ${target.normalizedTarget}`,
				provenance: contact,
				snapshot,
			}),
		),
	};
}

function originAsns(ripe: JsonRecord | undefined): number[] {
	const data = asRecord(ripe?.data);
	const values = asArray(data?.asns);
	const results: number[] = [];
	for (const value of values) {
		const normalized = String(value).trim().replace(/^AS/i, "");
		if (!/^\d+$/.test(normalized)) continue;
		const asn = Number(normalized);
		if (Number.isSafeInteger(asn) && asn >= 0 && asn <= 4_294_967_295 && !results.includes(asn)) results.push(asn);
	}
	return results;
}

async function resolveIpTarget(target: ResolverTarget, dependencies: ResolverDependencies): Promise<ResolvedAbuseTarget> {
	const rdapUrl = `${RDAP_IP_URL}${encodeURIComponent(target.normalizedTarget)}`;
	let ipRdap: JsonRecord | undefined;
	try {
		ipRdap = await safeJsonFetch(rdapUrl, dependencies);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const snapshot = { target: target.normalizedTarget, ipRdap: { error: message } };
		return { status: "failed", disposition: "resolver_failed", resolverSnapshot: snapshot, routes: [unroutableRoute("resolver_failed", snapshot, "failed")] };
	}

	if (!ipRdap) {
		const snapshot = { target: target.normalizedTarget, ipRdap: { result: "not_found" } };
		return { status: "no_route", disposition: "no_verified_abuse_contact", resolverSnapshot: snapshot, routes: [unroutableRoute("no_verified_abuse_contact", snapshot)] };
	}

	const ipRdapContacts = dedupeMailboxes(explicitAbuseMailboxes(ipRdap, "ip_rdap"));
	const port43 = extractPort43(ipRdap);
	const whois = ipRdapContacts.length === 0 ? await queryPort43(port43, target.normalizedTarget, dependencies) : {};
	const whoisContacts = dedupeMailboxes(
		(whois.raw ? parseExplicitWhoisAbuseMailboxes(whois.raw) : []).map((email) => ({ email, source: "ip_whois" as const })),
	);

	let ripe: JsonRecord | undefined;
	let ripeError: string | undefined;
	try {
		ripe = await safeJsonFetch(`${RIPE_NETWORK_INFO_URL}${encodeURIComponent(target.normalizedTarget)}`, dependencies);
	} catch (error) {
		ripeError = error instanceof Error ? error.message : String(error);
	}

	const asns = originAsns(ripe);
	const asnRdap: Array<{ asn: number; rdap?: JsonRecord; error?: string; explicitAbuseMailboxes: AbuseMailbox[]; organization?: JsonRecord }> = [];
	for (const asn of asns) {
		try {
			const rdap = await safeJsonFetch(`${RDAP_AUTNUM_URL}${asn}`, dependencies);
			asnRdap.push({
				asn,
				rdap,
				explicitAbuseMailboxes: dedupeMailboxes(explicitAbuseMailboxes(rdap, "asn_rdap")),
				organization: entityOrganization(rdap),
			});
		} catch (error) {
			asnRdap.push({
				asn,
				error: error instanceof Error ? error.message : String(error),
				explicitAbuseMailboxes: [],
			});
		}
	}
	const asnContacts = dedupeMailboxes(asnRdap.flatMap((entry) => entry.explicitAbuseMailboxes));

	// This is deliberately a fallback chain. We retain all independently
	// resolved identities in the snapshot, but report to the allocation's
	// explicit abuse contact first; only if it is absent do we use WHOIS, then
	// the BGP-origin ASN's explicit abuse contact.
	const contacts = ipRdapContacts.length > 0 ? ipRdapContacts : whoisContacts.length > 0 ? whoisContacts : asnContacts;
	const snapshot: JsonRecord = {
		target: target.normalizedTarget,
		allocationOwner: entityOrganization(ipRdap),
		ipRdap: {
			data: ipRdap,
			explicitAbuseMailboxes: ipRdapContacts,
		},
		port43Whois: {
			server: port43,
			sha256: whois.raw ? sha256Hex(whois.raw) : undefined,
			networkMetadata: whois.raw ? parseWhoisNetworkMetadata(whois.raw) : undefined,
			explicitAbuseMailboxes: whoisContacts,
			error: whois.error,
		},
		bgpOrigin: {
			prefix: text(asRecord(ripe?.data)?.prefix),
			asns,
			error: ripeError,
		},
		asnRdap,
	};

	if (contacts.length === 0) {
		return { status: "no_route", disposition: "no_verified_abuse_contact", resolverSnapshot: snapshot, routes: [unroutableRoute("no_verified_abuse_contact", snapshot)] };
	}

	return {
		status: "resolved",
		resolverSnapshot: snapshot,
		routes: contacts.map((contact) =>
			emailRoute({
				email: contact.email,
				providerName: contact.entityName ?? `Abuse contact for ${target.normalizedTarget}`,
				provenance: contact,
				snapshot,
			}),
		),
	};
}

/**
 * Resolves one already-normalized public target into durable route candidates.
 * It is deliberately independent from legacy `website_info` so its fallback
 * chain, port-43 contract, and full resolver provenance remain auditable.
 */
export async function resolveAbuseTarget(target: ResolverTarget, dependencies: ResolverDependencies = {}): Promise<ResolvedAbuseTarget> {
	if (target.targetType === "domain") return resolveDomainTarget(target, dependencies);
	if (target.targetType === "ip") return resolveIpTarget(target, dependencies);
	throw new Error("Unsupported abuse target type.");
}
