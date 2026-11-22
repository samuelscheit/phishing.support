import { originAsns } from "./bgp";
import { fetchRdapRecord, safeJsonFetch } from "./http";
import { asRecord, text } from "../../util/values";
import {
	dedupeMailboxes,
	entityOrganization,
	extractPort43,
	explicitAbuseMailboxes,
} from "./rdap";
import { contactChainProvenance, contactRoute, unroutableRoute } from "./routes";
import { queryPort43 } from "./port43";
import { parseExplicitWhoisAbuseMailboxes, parseWhoisNetworkMetadata } from "./whois";
import type { AbuseMailbox, JsonRecord, ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";
import { errorText } from "../../util/error_text";
import { sha256Hex } from "../../util/hash";
import { enclosingPrefix, strictlyInside } from "../../network/ip_prefix";
import { asArray } from "./records";

const RIPE_NETWORK_INFO_URL = "https://stat.ripe.net/data/network-info/data.json?resource=";
const RIPE_ASN_NEIGHBOURS_URL = "https://stat.ripe.net/data/asn-neighbours/data.json?resource=AS";

/** How many less-specific objects above the allocation are read; RIR trees are rarely deeper. */
const MAX_PARENT_OBJECTS = 4;

/**
 * The Regional Internet Registries' own mailboxes. A registry's covering
 * block lists them, but every RIR states it cannot investigate network abuse
 * (APNIC's 14.0.0.0/8: "unable to investigate complaints of network abuse"),
 * so they are never a fallback for an abuse report.
 */
const REGISTRY_MAIL_DOMAINS = ["afrinic.net", "apnic.net", "arin.net", "lacnic.net", "ripe.net"];

function isRegistryMailbox(email: string): boolean {
	const domain = email.split("@").at(-1)!;
	return REGISTRY_MAIL_DOMAINS.some((registry) => domain === registry || domain.endsWith(`.${registry}`));
}

type AsnRdapResult = {
	asn: number;
	rdap?: JsonRecord;
	error?: string;
	explicitAbuseMailboxes: AbuseMailbox[];
	organization?: JsonRecord;
};

type ParentObject = { query: string; handle?: string; startAddress?: string; endAddress?: string; explicitAbuseMailboxes: AbuseMailbox[] };

/** An autonomous system's explicit abuse mailboxes from its RDAP record, labelled with its holder. */
async function asnAbuseContacts(asn: number, source: "asn_rdap" | "upstream_asn_rdap", dependencies: ResolverDependencies): Promise<AsnRdapResult> {
	try {
		const rdap = await fetchRdapRecord("autnum", String(asn), dependencies);
		const organization = entityOrganization(firstOrganizationEntity(rdap) ?? rdap);
		const name = text(organization?.organization) ?? text(rdap?.name);
		return {
			asn,
			rdap,
			explicitAbuseMailboxes: dedupeMailboxes(explicitAbuseMailboxes(rdap, source)).map((mailbox) => ({ ...mailbox, ...(name ? { organization: name } : {}) })),
			organization,
		};
	} catch (error) {
		return { asn, error: errorText(error), explicitAbuseMailboxes: [] };
	}
}

/** The registrant entity of an autnum record, which names the network's holder. */
function firstOrganizationEntity(rdap: JsonRecord | undefined): JsonRecord | undefined {
	return asArray(rdap?.entities).map(asRecord).find((entity) => asArray(entity?.roles).includes("registrant"));
}

/**
 * The objects above the allocation in the registry's tree, nearest first: each
 * found by asking RDAP for the prefix just larger than the last one's range.
 * Stops at the registry's own covering block, at an object that is not larger
 * (a server that does not answer less-specific queries), or on a failure.
 */
async function parentObjects(allocation: JsonRecord, dependencies: ResolverDependencies): Promise<{ objects: ParentObject[]; error?: string }> {
	const objects: ParentObject[] = [];
	let current = { start: text(allocation.startAddress), end: text(allocation.endAddress) };
	while (objects.length < MAX_PARENT_OBJECTS && current.start && current.end) {
		const query = enclosingPrefix(current.start, current.end);
		if (!query) break;
		let record: JsonRecord | undefined;
		try {
			record = await fetchRdapRecord("ip", query, dependencies);
		} catch (error) {
			return { objects, error: `${query}: ${errorText(error)}` };
		}
		const next = { start: text(record?.startAddress), end: text(record?.endAddress) };
		if (!record || !next.start || !next.end || !strictlyInside({ start: current.start, end: current.end }, { start: next.start, end: next.end })) break;
		const mailboxes = dedupeMailboxes(explicitAbuseMailboxes(record, "parent_ip_rdap"));
		if (mailboxes.some((mailbox) => isRegistryMailbox(mailbox.email))) break;
		objects.push({ query, handle: text(record.handle), startAddress: next.start, endAddress: next.end, explicitAbuseMailboxes: mailboxes });
		current = next;
	}
	return { objects };
}

/**
 * The origin's main transit provider: of the ASNs RIPEstat sees directly
 * upstream ("left") of it, the one in the most observed paths.
 */
async function dominantUpstream(asn: number, dependencies: ResolverDependencies): Promise<{ asn?: number; error?: string }> {
	try {
		const data = asRecord((await safeJsonFetch(`${RIPE_ASN_NEIGHBOURS_URL}${asn}`, dependencies))?.data);
		const upstreams = asArray(data?.neighbours).map(asRecord).flatMap((neighbour) => {
			const upstream = Number(neighbour?.asn);
			const power = Number(neighbour?.power);
			return neighbour?.type === "left" && Number.isSafeInteger(upstream) && upstream > 0 && upstream !== asn && Number.isFinite(power) ? [{ asn: upstream, power }] : [];
		});
		return { asn: upstreams.sort((a, b) => b.power - a.power)[0]?.asn };
	} catch (error) {
		return { error: errorText(error) };
	}
}

/**
 * Every published abuse contact for an address, in the order a report tries
 * them: the allocation's own (RDAP, else its port-43 WHOIS), then those of
 * the less-specific objects above it, then the BGP-origin ASN's, then the
 * origin's dominant upstream transit provider's. The first is reported to;
 * the rest are its fallbacks, used one at a time when a mailbox permanently
 * rejects the report (worker/mail.ts routeToNextContact).
 */
export async function resolveIpTarget(target: ResolverTarget, dependencies: ResolverDependencies): Promise<ResolvedAbuseTarget> {
	let ipRdap: JsonRecord | undefined;
	try {
		ipRdap = await fetchRdapRecord("ip", target.normalizedTarget, dependencies);
	} catch (error) {
		const message = errorText(error);
		const snapshot = { target: target.normalizedTarget, ipRdap: { error: message } };
		return {
			status: "failed",
			disposition: "resolver_failed",
			resolverSnapshot: snapshot,
			routes: [unroutableRoute("resolver_failed", snapshot, "failed")],
			lookupFailures: [`IP RDAP for ${target.normalizedTarget}: ${message}`],
		};
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
	const parents = await parentObjects(ipRdap, dependencies);

	let ripe: JsonRecord | undefined;
	let ripeError: string | undefined;
	try {
		ripe = await safeJsonFetch(`${RIPE_NETWORK_INFO_URL}${encodeURIComponent(target.normalizedTarget)}`, dependencies);
	} catch (error) {
		ripeError = errorText(error);
	}
	const prefix = text(asRecord(ripe?.data)?.prefix);
	const asns = originAsns(ripe);
	const asnRdap: AsnRdapResult[] = [];
	for (const asn of asns) asnRdap.push(await asnAbuseContacts(asn, "asn_rdap", dependencies));

	const upstreams: Array<{ customerAsn: number; upstreamAsn?: number; error?: string; rdap?: AsnRdapResult }> = [];
	for (const origin of asnRdap) {
		const upstream = await dominantUpstream(origin.asn, dependencies);
		if (!upstream.asn || asns.includes(upstream.asn)) {
			upstreams.push({ customerAsn: origin.asn, ...upstream });
			continue;
		}
		const rdap = await asnAbuseContacts(upstream.asn, "upstream_asn_rdap", dependencies);
		const customerOrganization = text(origin.organization?.organization);
		rdap.explicitAbuseMailboxes = rdap.explicitAbuseMailboxes
			.filter((mailbox) => !isRegistryMailbox(mailbox.email))
			.map((mailbox) => ({
				...mailbox,
				transit: { upstreamAsn: upstream.asn!, customerAsn: origin.asn, ...(customerOrganization ? { customerOrganization } : {}), ...(prefix ? { customerPrefix: prefix } : {}) },
			}));
		upstreams.push({ customerAsn: origin.asn, upstreamAsn: upstream.asn, rdap });
	}

	const contacts = dedupeMailboxes([
		...(ipRdapContacts.length > 0 ? ipRdapContacts : whoisContacts),
		...parents.objects.flatMap((object) => object.explicitAbuseMailboxes),
		...asnRdap.flatMap((entry) => entry.explicitAbuseMailboxes),
		...upstreams.flatMap((entry) => entry.rdap?.explicitAbuseMailboxes ?? []),
	]);
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
		parentObjects: parents,
		bgpOrigin: {
			prefix,
			asns,
			error: ripeError,
		},
		asnRdap,
		upstreamTransit: upstreams.map(({ rdap, ...upstream }) => ({ ...upstream, ...(rdap ? { explicitAbuseMailboxes: rdap.explicitAbuseMailboxes, organization: rdap.organization, error: rdap.error } : {}) })),
	};

	const [primary, ...fallbacks] = contacts;
	if (!primary) {
		// A failed lookup may hide a contact, so the resolution is worth repeating.
		const lookupFailures = [
			...(parents.error ? [`Less-specific IP RDAP for ${target.normalizedTarget}: ${parents.error}`] : []),
			...(ripeError ? [`BGP origin for ${target.normalizedTarget}: ${ripeError}`] : []),
			...asnRdap.flatMap((entry) => entry.error ? [`AS${entry.asn} RDAP: ${entry.error}`] : []),
		];
		return {
			status: "no_route",
			disposition: "no_verified_abuse_contact",
			resolverSnapshot: snapshot,
			routes: [unroutableRoute("no_verified_abuse_contact", snapshot)],
			...(lookupFailures.length > 0 ? { lookupFailures } : {}),
		};
	}

	return {
		status: "resolved",
		resolverSnapshot: snapshot,
		routes: [contactRoute({
			email: primary.email,
			providerName: primary.entityName ?? `Abuse contact for ${target.normalizedTarget}`,
			provenance: contactChainProvenance([primary, ...fallbacks]),
			snapshot,
		})],
	};
}
