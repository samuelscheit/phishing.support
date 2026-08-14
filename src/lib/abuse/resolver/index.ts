import { resolveDomainTarget } from "./domain";
import { resolveIpTarget } from "./ip";
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
	if (target.targetType === "domain") return resolveDomainTarget(target, dependencies);
	if (target.targetType === "ip") return resolveIpTarget(target, dependencies);
	throw new Error("Unsupported abuse target type.");
}
