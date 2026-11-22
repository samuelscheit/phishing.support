import {
	emailRoute,
	getProviderSubmissionProviderForMailbox,
	providerContactRoute,
	verifiedDomainsForEmailRoute,
} from "../providers";
import type { ResolvedRouteInput } from "../route_contracts";
import type { AbuseMailbox, JsonRecord } from "./types";
import { asRecord } from "../../util/values";

/**
 * Resolve an explicit abuse mailbox once. A reviewed provider that owns the
 * exact mailbox receives a durable direct-submission route; every other
 * contact remains on the generic email path. The resolver never names a
 * concrete provider or infers ownership from an email domain.
 */
export function contactRoute(params: {
	email: string;
	providerName: string;
	provenance: JsonRecord;
	snapshot: JsonRecord;
}): ResolvedRouteInput {
	const provider = getProviderSubmissionProviderForMailbox(params.email);
	if (provider) {
		return providerContactRoute({
			provider,
			email: params.email,
			providerName: provider.definition.displayName,
			source: {
				resolverProvenance: params.provenance,
				resolutionSnapshot: params.snapshot,
			},
		});
	}
	return emailRoute(params);
}

export function unroutableRoute(reason: string, snapshot: JsonRecord, status: "no_route" | "failed" = "no_route"): ResolvedRouteInput {
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
	};
}

/** The first contact as the route's provenance, the rest as its fallbacks. */
export function contactChainProvenance([primary, ...fallbacks]: readonly [AbuseMailbox, ...AbuseMailbox[]]): JsonRecord {
	return { ...primary, ...(fallbacks.length ? { fallbackContacts: fallbacks.map(contactProvenance) } : {}) };
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
