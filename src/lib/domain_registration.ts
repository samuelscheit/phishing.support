import { getDomain } from "tldts";

import { fetchRdapRecord, safeJsonFetch } from "./abuse/resolver/http";
import { entityVcardText, extractRegistrarIdFromRdap, firstEntityWithRole, registrarRdapUrl } from "./abuse/resolver/rdap";
import type { JsonRecord, ResolverDependencies } from "./abuse/resolver/types";
import { registrableDomain } from "./abuse/security";
import { errorText } from "./error_text";
import { hasPathTenants } from "./website_site";

/**
 * Registrars that manage domains only for verified companies, under
 * contract, for their brand protection: a phishing kit cannot sign up there.
 * IANA registrar IDs as their RDAP records name them (amazon.com and
 * google.com: MarkMonitor 292; walmart.com: CSC 299; apple.com: Com Laude 470).
 */
export const BRAND_PROTECTION_REGISTRARS: Readonly<Record<number, string>> = {
	292: "MarkMonitor",
	299: "CSC Corporate Domains",
	470: "Com Laude",
};

/** A registrant name that hides the owner rather than naming it. */
const PLACEHOLDER_REGISTRANT = /redact|privacy|private|proxy|withheld|not disclosed|disclosure|data protected|gdpr|whois|masked|on behalf|registrant|n\/a|^none$|^null$|unknown/i;

/**
 * Who holds the domain a page is on, from its registry's and registrar's
 * RDAP records, as evidence for the page's classifier: a brand's own site
 * often sits on a domain other than its main one (AWS GovCloud's
 * amazonaws-us-gov.com, held by Amazon Technologies, Inc. at MarkMonitor
 * since 2012, read as an AWS lookalike on 2026-11-19).
 */
export type DomainRegistration =
	| {
		domain: string;
		registrar?: string;
		/** The registrar only serves verified companies' brand portfolios. */
		brandProtectionRegistrar: boolean;
		/** The registrant organization the record discloses, never a privacy placeholder. */
		registrant?: string;
		registered?: string;
		nameservers?: string[];
	}
	/** The page's host is one tenant of a platform: the platform's registration says nothing about who made the page. */
	| { platformTenant: string };

export type DomainRegistrationLookup = (hostname: string) => Promise<DomainRegistration | undefined>;

/**
 * A host that is a tenant of a platform is the tenant's site, never the
 * platform owner's: the public suffix list's private section names those
 * platforms (kit.firebaseapp.com, x.blogspot.com), and some hosts carry
 * tenants under a path (sites.google.com).
 */
export function platformTenantSite(hostname: string): string | undefined {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (hasPathTenants(host)) return host;
	const tenant = getDomain(host, { allowPrivateDomains: true });
	return tenant && tenant !== registrableDomain(host) ? tenant : undefined;
}

function registrationDate(record: JsonRecord | undefined): string | undefined {
	const events = Array.isArray(record?.events) ? record.events : [];
	for (const event of events) {
		const entry = event as { eventAction?: unknown; eventDate?: unknown };
		if (entry.eventAction !== "registration" || typeof entry.eventDate !== "string") continue;
		const date = new Date(entry.eventDate);
		if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
	}
	return undefined;
}

function nameserversOf(record: JsonRecord | undefined): string[] {
	const list = Array.isArray(record?.nameservers) ? record.nameservers : [];
	return list.flatMap((entry) => {
		const name = (entry as { ldhName?: unknown }).ldhName;
		return typeof name === "string" && name ? [name.toLowerCase().replace(/\.$/, "")] : [];
	});
}

function disclosedRegistrant(record: JsonRecord | undefined): string | undefined {
	const organization = entityVcardText(firstEntityWithRole(record, "registrant"), "org")?.replace(/\s+/g, " ").trim();
	return organization && !PLACEHOLDER_REGISTRANT.test(organization) ? organization : undefined;
}

/**
 * The registration of the domain a host is on: a thin registry (.com) names
 * the registrar, dates and nameservers, the registrar's own record the
 * registrant. Undefined for an IP or when no record exists.
 */
export async function domainRegistration(hostname: string, dependencies: ResolverDependencies = {}): Promise<DomainRegistration | undefined> {
	const tenant = platformTenantSite(hostname);
	if (tenant) return { platformTenant: tenant };
	const domain = registrableDomain(hostname);
	if (!domain) return undefined;
	const registry = await fetchRdapRecord("domain", domain, dependencies);
	if (!registry) return undefined;
	const registrarUrl = registrarRdapUrl(registry);
	const registrarRecord = registrarUrl ? await safeJsonFetch(registrarUrl, dependencies).catch(() => undefined) : undefined;
	const registrarEntity = firstEntityWithRole(registry, "registrar") ?? firstEntityWithRole(registrarRecord, "registrar");
	const registrarId = extractRegistrarIdFromRdap(registrarEntity);
	const registrar = (registrarId !== undefined ? BRAND_PROTECTION_REGISTRARS[registrarId] : undefined)
		?? entityVcardText(registrarEntity, "fn") ?? entityVcardText(registrarEntity, "org");
	const registrant = disclosedRegistrant(registrarRecord) ?? disclosedRegistrant(registry);
	const registered = registrationDate(registry) ?? registrationDate(registrarRecord);
	const nameservers = nameserversOf(registry);
	return {
		domain,
		...(registrar ? { registrar } : {}),
		brandProtectionRegistrar: registrarId !== undefined && registrarId in BRAND_PROTECTION_REGISTRARS,
		...(registrant ? { registrant } : {}),
		...(registered ? { registered } : {}),
		...(nameservers.length ? { nameservers } : {}),
	};
}

/** A visit classifies several pages of one site: each host is looked up once an hour. */
const REGISTRATION_TTL_MS = 60 * 60_000;
const registrations = new Map<string, { at: number; registration: Promise<DomainRegistration | undefined> }>();

/** The production lookup, cached per host: evidence, so a failure only leaves it out (and is not cached). */
export const lookupDomainRegistration: DomainRegistrationLookup = (hostname) => {
	const now = Date.now();
	for (const [host, entry] of registrations) if (now - entry.at > REGISTRATION_TTL_MS) registrations.delete(host);
	const cached = registrations.get(hostname);
	if (cached) return cached.registration;
	const registration = domainRegistration(hostname).catch((error) => {
		registrations.delete(hostname);
		console.warn(`Domain registration lookup for ${hostname} failed: ${errorText(error)}`);
		return undefined;
	});
	registrations.set(hostname, { at: now, registration });
	return registration;
};
