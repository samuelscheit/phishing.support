import type { AbuseRouteStatus, AbuseRouteType } from "./schema";

/**
 * Durable route data produced by resolution before it is persisted or queued.
 *
 * This belongs to the abuse domain rather than the repository: resolvers build
 * it and persistence stores it without either layer owning the other's API.
 */
export type ResolvedRouteInput = {
	routeKey: string;
	providerRegistryKey: string;
	providerDisplayName: string;
	routeType: AbuseRouteType;
	verifiedEmail?: string;
	providerDefinitionVersion?: string;
	providerDefinitionHash?: string;
	resolverProvenance: Record<string, unknown>;
	resolutionSnapshot: Record<string, unknown>;
	verificationResult?: Record<string, unknown>;
	serviceIdentity?: Record<string, unknown>;
	status?: AbuseRouteStatus;
};
