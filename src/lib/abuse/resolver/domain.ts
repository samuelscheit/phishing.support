import { getProviderSubmissionProviderForRegistrarId, providerRegistrarRoute } from "../providers";
import type { ResolvedRouteInput } from "../route_contracts";
import { finalizeDomainRouteResolution, resolveDomainInfrastructure, type DomainInfrastructureResolution } from "./domain_infrastructure";
import { fetchRdapRecord, safeJsonFetch } from "./http";
import {
	dedupeMailboxes,
	entityOrganization,
	extractPort43,
	extractRegistrarIdFromRdap,
	explicitAbuseMailboxes,
	firstEntityWithRole,
	registrarRdapUrl,
} from "./rdap";
import { contactChainProvenance } from "./contact_chain";
import { contactRoute, unroutableRoute } from "./routes";
import { queryPort43 } from "./port43";
import { parseExplicitWhoisAbuseMailboxes, parseWhoisNetworkMetadata } from "./whois";
import type { JsonRecord, ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";
import { hostRegistration } from "../../network/registered_domain";
import { errorText } from "../../util/error_text";
import { sha256Hex } from "../../util/hash";

/**
 * What the domain's registration contributes: its part of the resolver
 * snapshot, and the registrar's route, built on the complete snapshot, or why
 * the registrar has none.
 */
type RegistrarResolution = {
	snapshot: JsonRecord;
	route: ((snapshot: JsonRecord) => ResolvedRouteInput) | { reason: string; status: "no_route" | "failed" };
	lookupFailures?: string[];
};

/** A domain is reported to its registrar and, independently, to every network hosting it. */
export async function resolveDomainTarget(target: ResolverTarget, dependencies: ResolverDependencies): Promise<ResolvedAbuseTarget> {
	// Hosting stays reportable when the registry is unavailable, so both run at once.
	const infrastructurePromise = resolveDomainInfrastructure(target, dependencies).catch((error): DomainInfrastructureResolution => ({
		routes: [],
		snapshot: { error: errorText(error) },
		lookupFailures: [`hosting: ${errorText(error)}`],
	}));
	const registration = hostRegistration(target.normalizedTarget) ?? { domain: target.normalizedTarget };
	const registrar: RegistrarResolution = "platformTenant" in registration
		// A tenant's registrar is the platform's: only its hosting takes it down.
		? { snapshot: { platformTenant: registration.platformTenant }, route: { reason: "platform_tenant", status: "no_route" } }
		: await resolveRegistrar(registration.domain, dependencies);
	const infrastructure = await infrastructurePromise;

	const snapshot: JsonRecord = { target: target.normalizedTarget, ...registrar.snapshot, infrastructure: infrastructure.snapshot };
	const resolved = typeof registrar.route === "function"
		? finalizeDomainRouteResolution({
			resolverSnapshot: snapshot,
			domainRoutes: [registrar.route(snapshot)],
			infrastructureRoutes: infrastructure.routes,
			baseStatus: "resolved",
		})
		: finalizeDomainRouteResolution({
			resolverSnapshot: snapshot,
			domainRoutes: [unroutableRoute(registrar.route.reason, snapshot, registrar.route.status)],
			infrastructureRoutes: infrastructure.routes,
			baseStatus: registrar.route.status,
			baseDisposition: registrar.route.reason,
		});
	const lookupFailures = [...(registrar.lookupFailures ?? []), ...infrastructure.lookupFailures];
	return lookupFailures.length > 0 ? { ...resolved, lookupFailures } : resolved;
}

/** The registrar of a registered domain and its abuse route, from the registry's and registrar's RDAP and port-43 WHOIS. */
async function resolveRegistrar(domain: string, dependencies: ResolverDependencies): Promise<RegistrarResolution> {
	let rdap: JsonRecord | undefined;
	try {
		rdap = await fetchRdapRecord("domain", domain, dependencies);
	} catch (error) {
		const message = errorText(error);
		return {
			snapshot: { registeredDomain: domain, domainRdap: { error: message } },
			route: { reason: "resolver_failed", status: "failed" },
			lookupFailures: [`domain RDAP: ${message}`],
		};
	}
	if (!rdap) {
		return { snapshot: { registeredDomain: domain, domainRdap: { result: "not_found" } }, route: { reason: "no_verified_abuse_contact", status: "no_route" } };
	}

	// Registry responses frequently wrap the registrar below a top-level
	// organizational entity. Search the complete RDAP entity tree while still
	// requiring the explicit `registrar` role; display names are never routing
	// input.
	const registrar = firstEntityWithRole(rdap, "registrar");
	const registrarId = extractRegistrarIdFromRdap(registrar);
	// The registry's record names the registrar's abuse mailbox as the registrar
	// last reported it, which can be stale: keychainagent.pro's registry RDAP
	// names abuse@eranet.com, a mailbox that no longer exists, while Eranet's own
	// RDAP names support@tnet.hk. The registrar's own record is asked first.
	const registrarRdap = await fetchRegistrarRdap(rdap, dependencies);
	const registrarRdapContacts = registrarRdap.record
		? explicitAbuseMailboxes(firstEntityWithRole(registrarRdap.record, "registrar") ?? registrarRdap.record, "registrar_rdap")
		: [];
	const rdapContacts = dedupeMailboxes([...registrarRdapContacts, ...explicitAbuseMailboxes(registrar, "domain_rdap")]);
	const port43 = extractPort43(rdap);
	const whois = rdapContacts.length === 0 ? await queryPort43(port43, domain, dependencies) : {};
	const whoisContacts = dedupeMailboxes(
		(whois.raw ? parseExplicitWhoisAbuseMailboxes(whois.raw) : []).map((email) => ({ email, source: "domain_whois" as const })),
	);
	const contacts = rdapContacts.length > 0 ? rdapContacts : whoisContacts;
	const snapshot: JsonRecord = {
		registeredDomain: domain,
		registrar: {
			id: registrarId,
			identity: entityOrganization(registrar),
			explicitAbuseMailboxes: rdapContacts,
		},
		domainRdap: rdap,
		registrarRdap: registrarRdap.record ? { url: registrarRdap.url, record: registrarRdap.record } : { url: registrarRdap.url, error: registrarRdap.error },
		port43Whois: {
			server: port43,
			sha256: whois.raw ? sha256Hex(whois.raw) : undefined,
			explicitAbuseMailboxes: whoisContacts,
			networkMetadata: whois.raw ? parseWhoisNetworkMetadata(whois.raw) : undefined,
			error: whois.error,
		},
	};

	const registrarForm = getProviderSubmissionProviderForRegistrarId(registrarId);
	if (registrarForm) {
		// A registrar that takes abuse reports through its own form gets that
		// form, whatever its RDAP mailboxes say. The mailboxes stay recorded.
		return {
			snapshot,
			route: (resolutionSnapshot) => providerRegistrarRoute({
				provider: registrarForm,
				registrarId: registrarId!,
				source: { resolverProvenance: { source: "domain_rdap", registrarId }, resolutionSnapshot },
			}),
		};
	}
	if (contacts.length === 0) return { snapshot, route: { reason: "no_verified_abuse_contact", status: "no_route" } };

	// One contact is reported to at a time. The others are its fallbacks, used
	// in order when a mail server permanently rejects the mailbox.
	const [primary, ...fallbacks] = contacts;
	return {
		snapshot,
		route: (resolutionSnapshot) => contactRoute({
			email: primary!.email,
			providerName: primary!.entityName ?? `Abuse contact for ${domain}`,
			provenance: contactChainProvenance([primary!, ...fallbacks]),
			snapshot: resolutionSnapshot,
		}),
	};
}

/** The registrar's own RDAP record for the domain, from the registry's `related` link. */
export async function fetchRegistrarRdap(registryRecord: JsonRecord, dependencies: ResolverDependencies): Promise<{ url?: string; record?: JsonRecord; error?: string }> {
	const url = registrarRdapUrl(registryRecord);
	if (!url) return {};
	try {
		const record = await safeJsonFetch(url, dependencies);
		return record ? { url, record } : { url, error: "not_found" };
	} catch (error) {
		return { url, error: errorText(error) };
	}
}
