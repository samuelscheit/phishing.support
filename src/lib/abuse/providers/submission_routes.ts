import type { ResolvedRouteInput } from "../route_contracts";
import type { ProviderSubmissionProvider } from "./submission_contracts";

/** A route that mails an explicit abuse mailbox. */
export function emailRoute(params: {
	email: string;
	providerName: string;
	provenance: Record<string, unknown>;
	snapshot: Record<string, unknown>;
}): ResolvedRouteInput {
	const domain = params.email.slice(params.email.lastIndexOf("@") + 1);
	return {
		routeKey: `email:${params.email}`,
		providerRegistryKey: `email:${domain}`,
		providerDisplayName: params.providerName,
		routeType: "email",
		verifiedEmail: params.email,
		resolverProvenance: params.provenance,
		resolutionSnapshot: params.snapshot,
		status: "verified",
	};
}

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
		status: "verified",
	};
}

/** Build a pinned route for a registrar that takes abuse reports through its own form. */
export function providerRegistrarRoute(params: {
	provider: ProviderSubmissionProvider;
	registrarId: number;
	source: ProviderRouteSource;
}): ResolvedRouteInput {
	const { provider } = params;
	return {
		routeKey: `provider_submission:${provider.definition.key}:registrar`,
		providerRegistryKey: provider.definition.key,
		providerDisplayName: provider.definition.displayName,
		routeType: "provider_submission",
		providerDefinitionVersion: provider.definition.version,
		providerDefinitionHash: provider.definition.contentHash,
		resolverProvenance: {
			...params.source.resolverProvenance,
			match: "registrar_iana_id",
			registrarId: params.registrarId,
			providerRegistryKey: provider.definition.key,
		},
		resolutionSnapshot: params.source.resolutionSnapshot,
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
		status: "verified",
	};
}
