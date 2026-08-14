import dns from "node:dns/promises";

import { isPublicIp } from "../security";
import type { ResolvedRouteInput } from "../route_contracts";
import { resolveIpTarget } from "./ip";
import type { JsonRecord, ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";

const MAX_INFRASTRUCTURE_IPS = 16;

type DomainAddressLookup = {
	publicAddresses: string[];
	snapshot: JsonRecord;
};

export type DomainInfrastructureResolution = {
	routes: ResolvedRouteInput[];
	snapshot: JsonRecord;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve only the public addresses that can identify hosting infrastructure.
 * DNS answers are untrusted input: private/special-use answers never reach the
 * IP resolver, duplicate answers do not fan out work, and the total number of
 * external RDAP lookups remains bounded.
 */
async function lookupInfrastructureAddresses(domain: string, dependencies: ResolverDependencies): Promise<DomainAddressLookup> {
	let rawAddresses: unknown[] = [];
	let source: "dependency" | "dns" = "dependency";
	const errors: JsonRecord[] = [];
	const records: JsonRecord = {};

	if (dependencies.resolveDomainAddresses) {
		try {
			const resolved = await dependencies.resolveDomainAddresses(domain);
			rawAddresses = Array.isArray(resolved) ? resolved : [];
			records.combined = { addresses: rawAddresses };
			if (!Array.isArray(resolved)) errors.push({ source: "dependency", error: "Domain address resolver returned a non-array result." });
		} catch (error) {
			errors.push({ source: "dependency", error: errorMessage(error) });
		}
	} else {
		source = "dns";
		const [ipv4, ipv6] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
		for (const [recordType, result] of [["A", ipv4], ["AAAA", ipv6]] as const) {
			if (result.status === "fulfilled") {
				records[recordType] = { addresses: result.value };
				rawAddresses.push(...result.value);
			} else {
				const error = errorMessage(result.reason);
				records[recordType] = { error };
				errors.push({ recordType, error });
			}
		}
	}

	const publicAddresses: string[] = [];
	const seen = new Set<string>();
	const ignoredAddresses: JsonRecord[] = [];
	for (const rawAddress of rawAddresses) {
		if (typeof rawAddress !== "string") {
			ignoredAddresses.push({ address: String(rawAddress), reason: "not_an_ip_address" });
			continue;
		}
		const address = rawAddress.trim();
		if (!isPublicIp(address)) {
			ignoredAddresses.push({ address, reason: "not_public_ip" });
			continue;
		}
		const identity = address.toLowerCase();
		if (seen.has(identity)) {
			ignoredAddresses.push({ address, reason: "duplicate" });
			continue;
		}
		seen.add(identity);
		if (publicAddresses.length >= MAX_INFRASTRUCTURE_IPS) {
			ignoredAddresses.push({ address, reason: "infrastructure_ip_limit" });
			continue;
		}
		publicAddresses.push(address);
	}

	return {
		publicAddresses,
		snapshot: {
			source,
			maximumInfrastructureIps: MAX_INFRASTRUCTURE_IPS,
			records,
			publicAddresses,
			ignoredAddresses,
			errors,
		},
	};
}

/**
 * The route remains attached to the submitted domain target, while retaining
 * the independently resolved infrastructure identity that produced it. This
 * prevents an IP-hosting contact from being mistaken for a domain registrar
 * contact after durable route persistence.
 */
function attachInfrastructureRoute(params: {
	domain: string;
	ip: string;
	dnsSnapshot: JsonRecord;
	route: ResolvedRouteInput;
}): ResolvedRouteInput {
	return {
		...params.route,
		resolverProvenance: {
			source: "domain_infrastructure_ip",
			originatingDomain: params.domain,
			originatingIp: params.ip,
			dnsResolution: params.dnsSnapshot,
			ipRouteProvenance: params.route.resolverProvenance,
		},
		resolutionSnapshot: {
			target: params.domain,
			source: "domain_infrastructure_ip",
			infrastructureIp: params.ip,
			ipResolution: params.route.resolutionSnapshot,
		},
	};
}

function sourceHistory(record: JsonRecord, key: "sourceProvenance" | "sourceSnapshots"): JsonRecord[] {
	const existing = record[key];
	if (Array.isArray(existing) && existing.every(isRecord)) return existing;
	const { [key]: _ignored, ...source } = record;
	return [source];
}

/**
 * A mailbox/provider route can be discovered through more than one address.
 * Persisting just the last route would discard why it was selected, while
 * emitting duplicates would let persistence overwrite them nondeterministically.
 */
function mergeDuplicateRoutes(routes: readonly ResolvedRouteInput[]): ResolvedRouteInput[] {
	const byRouteKey = new Map<string, ResolvedRouteInput>();
	for (const route of routes) {
		const existing = byRouteKey.get(route.routeKey);
		if (!existing) {
			byRouteKey.set(route.routeKey, route);
			continue;
		}

		const existingProvenance = sourceHistory(existing.resolverProvenance, "sourceProvenance");
		const incomingProvenance = sourceHistory(route.resolverProvenance, "sourceProvenance");
		const existingSnapshots = sourceHistory(existing.resolutionSnapshot, "sourceSnapshots");
		const incomingSnapshots = sourceHistory(route.resolutionSnapshot, "sourceSnapshots");
		existing.resolverProvenance = {
			...existing.resolverProvenance,
			sourceProvenance: [...existingProvenance, ...incomingProvenance],
		};
		existing.resolutionSnapshot = {
			...existing.resolutionSnapshot,
			sourceSnapshots: [...existingSnapshots, ...incomingSnapshots],
		};

		// `manual_unroutable` is the only duplicate route that can use both
		// terminal resolver statuses. Keep a failure rather than weakening it to
		// no-route while the aggregate still has no actionable route.
		if (route.status === "failed" && existing.status === "no_route") existing.status = "failed";
	}
	return [...byRouteKey.values()];
}

function isActionableRoute(route: ResolvedRouteInput): boolean {
	return route.routeType !== "manual_unroutable" && route.status !== "no_route" && route.status !== "failed";
}

export async function resolveDomainInfrastructure(target: ResolverTarget, dependencies: ResolverDependencies): Promise<DomainInfrastructureResolution> {
	const addressLookup = await lookupInfrastructureAddresses(target.normalizedTarget, dependencies);
	const resolutions = await Promise.all(addressLookup.publicAddresses.map(async (ip) => {
		try {
			const resolved = await resolveIpTarget({
				normalizedTarget: ip,
				targetType: "ip",
				observedUrls: target.observedUrls,
			}, dependencies);
			return {
				ip,
				status: resolved.status,
				disposition: resolved.disposition,
				resolverSnapshot: resolved.resolverSnapshot,
				routes: resolved.routes.map((route) => attachInfrastructureRoute({
					domain: target.normalizedTarget,
					ip,
					dnsSnapshot: addressLookup.snapshot,
					route,
				})),
			};
		} catch (error) {
			return {
				ip,
				status: "failed" as const,
				disposition: "resolver_failed",
				resolverSnapshot: { target: ip, error: errorMessage(error) },
				routes: [],
			};
		}
	}));

	return {
		routes: resolutions.flatMap((resolution) => resolution.routes),
		snapshot: {
			dns: addressLookup.snapshot,
			ipResolutions: resolutions.map(({ routes: _routes, ...resolution }) => resolution),
		},
	};
}

export function finalizeDomainRouteResolution(params: {
	resolverSnapshot: JsonRecord;
	domainRoutes: ResolvedRouteInput[];
	infrastructureRoutes: ResolvedRouteInput[];
	baseStatus: "resolved" | "no_route" | "failed";
	baseDisposition?: string;
}): ResolvedAbuseTarget {
	const routes = mergeDuplicateRoutes([...params.domainRoutes, ...params.infrastructureRoutes]);
	const actionableRoutes = routes.filter(isActionableRoute);
	if (actionableRoutes.length > 0) {
		return {
			status: "resolved",
			resolverSnapshot: params.resolverSnapshot,
			// These are synthetic placeholders, not independent report paths. An
			// actionable route has already established that the target can be
			// reported, so retaining them would make the aggregate misleading.
			routes: routes.filter((route) => route.routeType !== "manual_unroutable"),
		};
	}

	return {
		status: params.baseStatus,
		disposition: params.baseDisposition,
		resolverSnapshot: params.resolverSnapshot,
		routes,
	};
}
