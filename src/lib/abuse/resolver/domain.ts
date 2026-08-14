import { getPortalProviderForRegistrarId } from "../providers";
import { sha256Hex } from "../security";
import { safeJsonFetch } from "./http";
import {
	dedupeMailboxes,
	entityOrganization,
	extractPort43,
	extractRegistrarIdFromRdap,
	explicitAbuseMailboxes,
	firstEntityWithRole,
} from "./rdap";
import { emailRoute, unroutableRoute } from "./routes";
import { queryPort43 } from "./port43";
import { parseExplicitWhoisAbuseMailboxes, parseWhoisNetworkMetadata } from "./whois";
import type { JsonRecord, ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";

const RDAP_DOMAIN_URL = "https://rdap.org/domain/";

export async function resolveDomainTarget(target: ResolverTarget, dependencies: ResolverDependencies): Promise<ResolvedAbuseTarget> {
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
	// organizational entity. Search the complete RDAP entity tree while still
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

	const provider = getPortalProviderForRegistrarId(registrarId);
	if (provider) {
		const route = provider.createRegistrarRoute({ registrarId: registrarId!, resolutionSnapshot: snapshot });
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
