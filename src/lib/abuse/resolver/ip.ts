import { sha256Hex } from "../security";
import { originAsns } from "./bgp";
import { safeJsonFetch } from "./http";
import { asRecord, text } from "./records";
import {
	dedupeMailboxes,
	entityOrganization,
	extractPort43,
	explicitAbuseMailboxes,
} from "./rdap";
import { contactRoute, unroutableRoute } from "./routes";
import { queryPort43 } from "./port43";
import { parseExplicitWhoisAbuseMailboxes, parseWhoisNetworkMetadata } from "./whois";
import type { AbuseMailbox, JsonRecord, ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";

const RDAP_IP_URL = "https://rdap.org/ip/";
const RDAP_AUTNUM_URL = "https://rdap.org/autnum/";
const RIPE_NETWORK_INFO_URL = "https://stat.ripe.net/data/network-info/data.json?resource=";

type AsnRdapResult = {
	asn: number;
	rdap?: JsonRecord;
	error?: string;
	explicitAbuseMailboxes: AbuseMailbox[];
	organization?: JsonRecord;
};

export async function resolveIpTarget(target: ResolverTarget, dependencies: ResolverDependencies): Promise<ResolvedAbuseTarget> {
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
	const asnRdap: AsnRdapResult[] = [];
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
			contactRoute({
				email: contact.email,
				providerName: contact.entityName ?? `Abuse contact for ${target.normalizedTarget}`,
				provenance: contact,
				snapshot,
			}),
		),
	};
}
