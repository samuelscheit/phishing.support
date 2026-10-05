import type { ResolvedRouteInput } from "../../route_contracts";
import { gnameServiceIdentity, isGnameEnabled } from "./config";
import { GNAME_PROVIDER } from "./definition";

/** Build the sole GNAME portal route from an exact IANA registrar-ID match. */
export function createGnameRegistrarRoute(params: {
	registrarId: number;
	resolutionSnapshot: Record<string, unknown>;
}): ResolvedRouteInput {
	const identity = gnameServiceIdentity();
	const enabled = isGnameEnabled();
	return {
		routeKey: GNAME_PROVIDER.key,
		providerRegistryKey: GNAME_PROVIDER.key,
		providerDisplayName: GNAME_PROVIDER.displayName,
		routeType: "skyvern_portal",
		providerDefinitionVersion: GNAME_PROVIDER.version,
		providerDefinitionHash: GNAME_PROVIDER.contentHash,
		resolverProvenance: { registrarId: params.registrarId, match: "exact_iana_registrar_id" },
		resolutionSnapshot: params.resolutionSnapshot,
		serviceIdentity: { name: identity.name, mailbox: identity.mailbox, verified: identity.verified },
		status: enabled ? "resolving" : "no_route",
		verificationResult: enabled ? undefined : { verified: false, reason: "provider_route_disabled_or_unproven" },
	};
}
