import { resolveDomainTarget } from "./domain";
import { resolveIpTarget } from "./ip";
import {
	listSupplementalProviderSubmissionProvidersForTarget,
	providerSupplementalRoute,
} from "../providers";
import type { ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";

export { extractRegistrarIdFromRdap } from "./rdap";
export { parseExplicitWhoisAbuseMailboxes } from "./whois";
export type { ResolverDependencies, ResolverTarget, ResolvedAbuseTarget } from "./types";

/**
 * Resolves one already-normalized public target into durable route candidates.
 * It is deliberately independent from legacy `website_info` so its fallback
 * chain, port-43 contract, and full resolver provenance remain auditable.
 */
export async function resolveAbuseTarget(target: ResolverTarget, dependencies: ResolverDependencies = {}): Promise<ResolvedAbuseTarget> {
	const resolved = target.targetType === "domain"
		? await resolveDomainTarget(target, dependencies)
		: target.targetType === "ip"
			? await resolveIpTarget(target, dependencies)
			: undefined;
	if (!resolved) throw new Error("Unsupported abuse target type.");

	const supplementalProviders = listSupplementalProviderSubmissionProvidersForTarget(target);
	if (supplementalProviders.length === 0) return resolved;

	// A supplemental provider is an actionable route in its own right. Do not
	// retain a synthetic manual-unroutable route beside it, because that would
	// make the public aggregate report a false total failure.
	const existingActionableRoutes = resolved.routes.filter((route) => route.routeType !== "manual_unroutable");
	const supplementalRoutes = supplementalProviders.map((provider) => providerSupplementalRoute({
		provider,
		source: {
			resolverProvenance: {
				source: "provider_supplemental_target_rule",
				targetType: target.targetType,
				observedUrls: target.observedUrls,
			},
			resolutionSnapshot: resolved.resolverSnapshot,
		},
	}));

	return {
		...resolved,
		status: "resolved",
		disposition: undefined,
		routes: [...existingActionableRoutes, ...supplementalRoutes],
	};
}
