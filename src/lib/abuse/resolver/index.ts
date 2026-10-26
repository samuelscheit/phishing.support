import { resolveDomainTarget } from "./domain";
import { resolveIpTarget } from "./ip";
import { unroutableRoute } from "./routes";
import {
	listSupplementalProviderSubmissionProvidersForTarget,
	providerSupplementalRoute,
} from "../providers";
import type { ResolvedAbuseTarget, ResolverDependencies, ResolverTarget } from "./types";

export { extractRegistrarIdFromRdap } from "./rdap";
export { parseExplicitWhoisAbuseMailboxes } from "./whois";
export type { ResolverDependencies, ResolverTarget, ResolvedAbuseTarget } from "./types";

/**
 * A reported email message has no registry or network owner of its own; its
 * sending infrastructure is a separate IP target. Only mail-aware
 * supplemental providers can act on the message.
 */
function resolveEmailMessageTarget(target: ResolverTarget): ResolvedAbuseTarget {
	const snapshot = { target: target.normalizedTarget, targetType: "email" };
	return { status: "no_route", disposition: "no_mail_report_provider", resolverSnapshot: snapshot, routes: [unroutableRoute("no_mail_report_provider", snapshot)] };
}

/**
 * Resolves one already-normalized target into durable route candidates with
 * full resolver provenance (RDAP, authoritative port-43 WHOIS, BGP origin).
 */
export async function resolveAbuseTarget(target: ResolverTarget, dependencies: ResolverDependencies = {}): Promise<ResolvedAbuseTarget> {
	const resolved = target.targetType === "domain"
		? await resolveDomainTarget(target, dependencies)
		: target.targetType === "ip"
			? await resolveIpTarget(target, dependencies)
			: resolveEmailMessageTarget(target);

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
