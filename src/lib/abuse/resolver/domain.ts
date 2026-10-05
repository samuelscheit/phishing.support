import { getPortalProviderForRegistrarId } from "../providers";
import { sha256Hex } from "../security";
import { finalizeDomainRouteResolution, resolveDomainInfrastructure, type DomainInfrastructureResolution } from "./domain_infrastructure";
import { safeJsonFetch } from "./http";
import {
	dedupeMailboxes,
	entityOrganization,
	extractPort43,
	extractRegistrarIdFromRdap,
	explicitAbuseMailboxes,
	firstEntityWithRole,
} from "./rdap";
import { contactRoute, unroutableRoute } from "./routes";
import { queryPort43 } from "./port43";
import { parseExplicitWhoisAbuseMailboxes, parseWhoisNetworkMetadata } from "./whois";
import type { JsonRecord, ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";

const RDAP_DOMAIN_URL = "https://rdap.org/domain/";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function resolveDomainTarget(target: ResolverTarget, dependencies: ResolverDependencies): Promise<ResolvedAbuseTarget> {
	// Infrastructure ownership remains useful even if the registrar RDAP
	// endpoint is unavailable, so do not make it conditional on domain RDAP.
	const infrastructurePromise = resolveDomainInfrastructure(target, dependencies).catch((error): DomainInfrastructureResolution => ({
		routes: [],
		snapshot: { error: errorMessage(error) },
	}));

	const rdapUrl = `${RDAP_DOMAIN_URL}${encodeURIComponent(target.normalizedTarget)}`;
	let rdap: JsonRecord | undefined;
	let rdapError: string | undefined;
	try {
		rdap = await safeJsonFetch(rdapUrl, dependencies);
	} catch (error) {
		rdapError = errorMessage(error);
	}
	const infrastructure = await infrastructurePromise;

	if (rdapError) {
		const snapshot: JsonRecord = {
			target: target.normalizedTarget,
			domainRdap: { error: rdapError },
			infrastructure: infrastructure.snapshot,
		};
		return finalizeDomainRouteResolution({
			resolverSnapshot: snapshot,
			domainRoutes: [unroutableRoute("resolver_failed", snapshot, "failed")],
			infrastructureRoutes: infrastructure.routes,
			baseStatus: "failed",
			baseDisposition: "resolver_failed",
		});
	}

	if (!rdap) {
		const snapshot: JsonRecord = {
			target: target.normalizedTarget,
			domainRdap: { result: "not_found" },
			infrastructure: infrastructure.snapshot,
		};
		return finalizeDomainRouteResolution({
			resolverSnapshot: snapshot,
			domainRoutes: [unroutableRoute("no_verified_abuse_contact", snapshot)],
			infrastructureRoutes: infrastructure.routes,
			baseStatus: "no_route",
			baseDisposition: "no_verified_abuse_contact",
		});
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
		infrastructure: infrastructure.snapshot,
	};

	const provider = getPortalProviderForRegistrarId(registrarId);
	if (provider) {
		const route = provider.createRegistrarRoute({ registrarId: registrarId!, resolutionSnapshot: snapshot });
		return finalizeDomainRouteResolution({
			resolverSnapshot: snapshot,
			domainRoutes: [route],
			infrastructureRoutes: infrastructure.routes,
			baseStatus: route.status === "no_route" ? "no_route" : "resolved",
			baseDisposition: route.status === "no_route" ? "provider_route_disabled_or_unproven" : undefined,
		});
	}

	if (contacts.length === 0) {
		return finalizeDomainRouteResolution({
			resolverSnapshot: snapshot,
			domainRoutes: [unroutableRoute("no_verified_abuse_contact", snapshot)],
			infrastructureRoutes: infrastructure.routes,
			baseStatus: "no_route",
			baseDisposition: "no_verified_abuse_contact",
		});
	}

	return finalizeDomainRouteResolution({
		resolverSnapshot: snapshot,
		domainRoutes: contacts.map((contact) =>
			contactRoute({
				email: contact.email,
				providerName: contact.entityName ?? `Abuse contact for ${target.normalizedTarget}`,
				provenance: contact,
				snapshot,
			}),
		),
		infrastructureRoutes: infrastructure.routes,
		baseStatus: "resolved",
	});
}
