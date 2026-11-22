import { ROUTE_MAIL_ATTACHMENT_KINDS } from "../mail/types";
import { AbuseRepository } from "../repository";
import type { ProviderSubmissionProvider } from "./submission_contracts";
import { emailRoute } from "./submission_routes";

/** Outcomes that settle a direct submission without having filed anything. */
const NOTHING_FILED = new Set(["provider_rejected", "needs_human", "insufficient_evidence"]);

/**
 * A provider that declares `emailFallback` still gets the report when its
 * direct submission settled without filing it: a sibling email route to the
 * mailbox the provider route was resolved from, carrying the same provenance
 * and snapshot (so an origin-host route keeps its own draft). Idempotent: the
 * route key is derived from the provider route, and the job is deduplicated.
 */
export async function fallBackToEmail(provider: ProviderSubmissionProvider, routeId: bigint, outcome: string): Promise<bigint | undefined> {
	if (!provider.definition.emailFallback || !NOTHING_FILED.has(outcome)) return undefined;
	const route = await AbuseRepository.getRoute(routeId);
	if (!route?.verifiedEmail || route.routeType !== "provider_submission") return undefined;
	const fallback = await AbuseRepository.upsertResolvedRoute(route.targetId, {
		...emailRoute({ email: route.verifiedEmail, providerName: route.providerDisplayName, provenance: route.resolverProvenance, snapshot: route.resolutionSnapshot }),
		routeKey: `email-fallback:${route.routeKey}`,
		resolverProvenance: { ...route.resolverProvenance, emailFallbackFromRouteId: route.id.toString(), emailFallbackReason: outcome },
	});
	// The provider route's own files (the origin-host evidence) go with its mail.
	for (const artifact of await AbuseRepository.listRouteArtifacts(route.id, ROUTE_MAIL_ATTACHMENT_KINDS)) {
		await AbuseRepository.saveRouteArtifactOnce({ reportId: route.reportId, routeId: fallback.id, name: artifact.name, kind: artifact.kind, mimeType: artifact.mimeType, buffer: artifact.blob, metadata: artifact.metadata ?? {} });
	}
	if (fallback.status === "verified") {
		await AbuseRepository.enqueueJob({ jobType: "send_email", reportId: route.reportId, routeId: fallback.id, payload: {}, dedupeKey: `email:${fallback.id.toString()}` });
	}
	await AbuseRepository.recomputeReportStatus(route.reportId);
	return fallback.id;
}
