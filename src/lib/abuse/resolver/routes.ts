import {
	getProviderSubmissionProviderForMailbox,
	providerContactRoute,
	verifiedDomainsForEmailRoute,
} from "../providers";
import type { ResolvedRouteInput } from "../route_contracts";
import type { JsonRecord } from "./types";

export function emailRoute(params: {
	email: string;
	providerName: string;
	provenance: JsonRecord;
	snapshot: JsonRecord;
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
		verificationResult: {
			verified: true,
			verifiedDomains: verifiedDomainsForEmailRoute(params.email),
		},
		status: "verified",
	};
}

/**
 * Resolve an explicit abuse mailbox once. A reviewed provider that owns the
 * exact mailbox receives a durable direct-submission route; every other
 * contact remains on the generic email path. The resolver never names a
 * concrete provider or infers ownership from an email domain.
 */
export function contactRoute(params: {
	email: string;
	providerName: string;
	provenance: JsonRecord;
	snapshot: JsonRecord;
}): ResolvedRouteInput {
	const provider = getProviderSubmissionProviderForMailbox(params.email);
	if (provider) {
		return providerContactRoute({
			provider,
			email: params.email,
			providerName: provider.definition.displayName,
			source: {
				resolverProvenance: params.provenance,
				resolutionSnapshot: params.snapshot,
			},
		});
	}
	return emailRoute(params);
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
