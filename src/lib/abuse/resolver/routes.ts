import {
	getProviderForRegistrarId,
	gnameServiceIdentity,
	isGenericEmailRouteEnabled,
	isProviderRouteEnabled,
	verifiedDomainsForEmailRoute,
} from "../registry";
import type { ResolvedRouteInput } from "../route_contracts";
import type { JsonRecord } from "./types";

export function emailRoute(params: {
	email: string;
	providerName: string;
	provenance: JsonRecord;
	snapshot: JsonRecord;
}): ResolvedRouteInput {
	const domain = params.email.slice(params.email.lastIndexOf("@") + 1);
	const enabled = isGenericEmailRouteEnabled();
	return {
		routeKey: `email:${params.email}`,
		providerRegistryKey: `email:${domain}`,
		providerDisplayName: params.providerName,
		routeType: "email",
		verifiedEmail: params.email,
		resolverProvenance: params.provenance,
		resolutionSnapshot: params.snapshot,
		verificationResult: {
			verified: enabled,
			verifiedDomains: verifiedDomainsForEmailRoute(params.email),
			...(enabled ? {} : { reason: "generic_email_route_disabled" }),
		},
		status: enabled ? "verified" : "no_route",
	};
}

export function unroutableRoute(reason: string, snapshot: JsonRecord, status: "no_route" | "failed" = "no_route"): ResolvedRouteInput {
	return {
		routeKey: "manual_unroutable",
		providerRegistryKey: "manual_unroutable",
		providerDisplayName: "No verified abuse route",
		routeType: "manual_unroutable",
		resolverProvenance: { reason },
		resolutionSnapshot: snapshot,
		status,
	};
}

export function gnameRoute(registrarId: number, snapshot: JsonRecord): ResolvedRouteInput {
	const definition = getProviderForRegistrarId(registrarId)!;
	const enabled = isProviderRouteEnabled(definition);
	const identity = gnameServiceIdentity();
	return {
		routeKey: definition.key,
		providerRegistryKey: definition.key,
		providerDisplayName: definition.displayName,
		routeType: "skyvern_portal",
		providerDefinitionVersion: definition.version,
		providerDefinitionHash: definition.contentHash,
		resolverProvenance: { registrarId, match: "exact_iana_registrar_id" },
		resolutionSnapshot: snapshot,
		serviceIdentity: { name: identity.name, mailbox: identity.mailbox, verified: identity.verified },
		status: enabled ? "resolving" : "no_route",
		verificationResult: enabled ? undefined : { verified: false, reason: "provider_route_disabled_or_unproven" },
	};
}
