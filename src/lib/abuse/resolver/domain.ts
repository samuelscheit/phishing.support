import { getPortalProviderForRegistrarId, getProviderSubmissionProviderForRegistrarId, providerRegistrarRoute } from "../providers";
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
	registrarRdapUrl,
} from "./rdap";
import { contactRoute, unroutableRoute } from "./routes";
import { queryPort43 } from "./port43";
import { parseExplicitWhoisAbuseMailboxes, parseWhoisNetworkMetadata } from "./whois";
import type { AbuseMailbox, JsonRecord, ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";
import { errorText } from "../../error_text";

const RDAP_DOMAIN_URL = "https://rdap.org/domain/";

export async function resolveDomainTarget(target: ResolverTarget, dependencies: ResolverDependencies): Promise<ResolvedAbuseTarget> {
	// Infrastructure ownership remains useful even if the registrar RDAP
	// endpoint is unavailable, so do not make it conditional on domain RDAP.
	const infrastructurePromise = resolveDomainInfrastructure(target, dependencies).catch((error): DomainInfrastructureResolution => ({
		routes: [],
		snapshot: { error: errorText(error) },
	}));

	const rdapUrl = `${RDAP_DOMAIN_URL}${encodeURIComponent(target.normalizedTarget)}`;
	let rdap: JsonRecord | undefined;
	let rdapError: string | undefined;
	try {
		rdap = await safeJsonFetch(rdapUrl, dependencies);
	} catch (error) {
		rdapError = errorText(error);
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
		registrarRdap: registrarRdap.record ? { url: registrarRdap.url, record: registrarRdap.record } : { url: registrarRdap.url, error: registrarRdap.error },
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

	const registrarForm = getProviderSubmissionProviderForRegistrarId(registrarId);
	if (registrarForm) {
		// A registrar that takes abuse reports through its own form gets that
		// form, whatever its RDAP mailboxes say. The mailboxes stay recorded.
		return finalizeDomainRouteResolution({
			resolverSnapshot: snapshot,
			domainRoutes: [providerRegistrarRoute({
				provider: registrarForm,
				registrarId: registrarId!,
				source: { resolverProvenance: { source: "domain_rdap", registrarId }, resolutionSnapshot: snapshot },
			})],
			infrastructureRoutes: infrastructure.routes,
			baseStatus: "resolved",
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

	// One contact is reported to at a time. The others are its fallbacks, used
	// in order when a mail server permanently rejects the mailbox.
	const [primary, ...fallbacks] = contacts;
	return finalizeDomainRouteResolution({
		resolverSnapshot: snapshot,
		domainRoutes: [contactRoute({
			email: primary!.email,
			providerName: primary!.entityName ?? `Abuse contact for ${target.normalizedTarget}`,
			provenance: { ...primary, ...(fallbacks.length ? { fallbackContacts: fallbacks.map(contactProvenance) } : {}) },
			snapshot,
		})],
		infrastructureRoutes: infrastructure.routes,
		baseStatus: "resolved",
	});
}

function contactProvenance(contact: AbuseMailbox): JsonRecord {
	return { email: contact.email, source: contact.source, ...(contact.entityName ? { entityName: contact.entityName } : {}) };
}

/** The registrar's own RDAP record for the domain, from the registry's `related` link. */
async function fetchRegistrarRdap(registryRecord: JsonRecord, dependencies: ResolverDependencies): Promise<{ url?: string; record?: JsonRecord; error?: string }> {
	const url = registrarRdapUrl(registryRecord);
	if (!url) return {};
	try {
		const record = await safeJsonFetch(url, dependencies);
		return record ? { url, record } : { url, error: "not_found" };
	} catch (error) {
		return { url, error: errorText(error) };
	}
}
