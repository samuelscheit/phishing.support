import type { ResolvedRouteInput } from "../route_contracts";
import type { ProviderSubmissionProvider } from "./submission_contracts";

export type ProviderRouteSource = {
	resolverProvenance: Record<string, unknown>;
	resolutionSnapshot: Record<string, unknown>;
};

/** Build a pinned route for an exact provider-owned abuse mailbox. */
export function providerContactRoute(params: {
	provider: ProviderSubmissionProvider;
	email: string;
	providerName?: string;
	source: ProviderRouteSource;
}): ResolvedRouteInput {
	const { provider } = params;
	return {
		routeKey: `provider_submission:${provider.definition.key}:contact`,
		providerRegistryKey: provider.definition.key,
		providerDisplayName: params.providerName ?? provider.definition.displayName,
		routeType: "provider_submission",
		verifiedEmail: params.email,
		providerDefinitionVersion: provider.definition.version,
		providerDefinitionHash: provider.definition.contentHash,
		resolverProvenance: {
			...params.source.resolverProvenance,
			match: "exact_provider_abuse_mailbox",
			providerRegistryKey: provider.definition.key,
		},
		resolutionSnapshot: params.source.resolutionSnapshot,
		verificationResult: { verified: true, method: "exact_provider_abuse_mailbox" },
		status: "verified",
	};
}

/** Build a pinned route for a provider that supplements contact resolution. */
export function providerSupplementalRoute(params: {
	provider: ProviderSubmissionProvider;
	source: ProviderRouteSource;
}): ResolvedRouteInput {
	const { provider } = params;
	return {
		routeKey: `provider_submission:${provider.definition.key}:supplemental`,
		providerRegistryKey: provider.definition.key,
		providerDisplayName: provider.definition.displayName,
		routeType: "provider_submission",
		providerDefinitionVersion: provider.definition.version,
		providerDefinitionHash: provider.definition.contentHash,
		resolverProvenance: {
			...params.source.resolverProvenance,
			match: "supplemental_provider_target_rule",
			providerRegistryKey: provider.definition.key,
		},
		resolutionSnapshot: params.source.resolutionSnapshot,
		verificationResult: { verified: true, method: "supplemental_provider_target_rule" },
		status: "verified",
	};
}
