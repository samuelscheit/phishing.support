import type { AbuseMailbox, JsonRecord } from "./types";
import { asRecord } from "../../util/values";

/**
 * A route's provenance names one contact, plus the contacts to try in order
 * after it (`fallbackContacts`) when its mailbox permanently rejects mail. For
 * a route found through a domain's hosting address the contact sits in
 * `ipRouteProvenance`, beside how the address was found; otherwise the
 * provenance is the contact itself.
 */
const INFRASTRUCTURE_SOURCE = "domain_infrastructure_ip";

/** The stored form of one contact: an AbuseMailbox without its lookup details. */
function contactProvenance(contact: AbuseMailbox): JsonRecord {
	return {
		email: contact.email,
		source: contact.source,
		...(contact.entityName ? { entityName: contact.entityName } : {}),
		...(contact.organization ? { organization: contact.organization } : {}),
		...(contact.transit ? { transit: contact.transit } : {}),
		...(contact.foundAt ? { foundAt: contact.foundAt } : {}),
	};
}

/** The first contact as the route's provenance, the rest as its fallbacks. */
export function contactChainProvenance([primary, ...fallbacks]: readonly [AbuseMailbox, ...AbuseMailbox[]]): JsonRecord {
	return { ...primary, ...(fallbacks.length ? { fallbackContacts: fallbacks.map(contactProvenance) } : {}) };
}

/** Where a domain's registrar is told: its registration's abuse contacts and the registrars' own forms. */
const REGISTRAR_SOURCES = new Set(["registrar_rdap", "domain_rdap", "domain_whois"]);

/** Whether a route reports to the registrar of its target's domain (not to a host, CDN or network). */
export function isRegistrarRoute(route: { resolverProvenance: unknown }): boolean {
	return REGISTRAR_SOURCES.has(String(asRecord(route.resolverProvenance)?.source));
}

/** The contact a route reports to, as its provenance records it. */
export function routeContact(provenance: unknown): JsonRecord {
	const record = asRecord(provenance) ?? {};
	return record.source === INFRASTRUCTURE_SOURCE ? asRecord(record.ipRouteProvenance) ?? {} : record;
}

/** The provenance of a route to `contact` that was found the same way as the route of `provenance`. */
export function withRouteContact(provenance: JsonRecord, contact: JsonRecord, fallbackContacts: readonly JsonRecord[]): JsonRecord {
	const fallbacks = fallbackContacts.length ? { fallbackContacts: [...fallbackContacts] } : {};
	if (provenance.source !== INFRASTRUCTURE_SOURCE) return { ...contact, ...fallbacks };
	const { fallbackContacts: _previous, ...found } = provenance;
	return { ...found, ipRouteProvenance: contact, ...fallbacks };
}

/** The contacts to try after the route's own, in order. */
export function fallbackContactsOf(provenance: JsonRecord): Array<JsonRecord & { email: string; source: string }> {
	const list = Array.isArray(provenance.fallbackContacts) ? provenance.fallbackContacts : [];
	return list.flatMap((item) => {
		const record = asRecord(item);
		return record && typeof record.email === "string" && typeof record.source === "string" ? [record as JsonRecord & { email: string; source: string }] : [];
	});
}
