import { getProviderDefinition, gnameServiceIdentity, isProviderRouteEnabled, providerDefinitionMatchesPin } from "../registry";
import { AbuseRepository } from "../repository";
import { verifyGnameRoute } from "../verification";
import { routeContext, type AbuseTargetResolver } from "./shared";

export async function resolveReport(reportId: bigint, resolveTarget: AbuseTargetResolver): Promise<void> {
	const input = await AbuseRepository.getReportInput(reportId);
	if (!input) throw new Error("Abuse report no longer exists.");
	// A resolver job can be replayed after a lease expiry. Once another
	// worker has moved the report into verification/execution or a terminal
	// aggregate, this old job must not reopen it or enqueue duplicate work.
	if (!["accepted", "resolving"].includes(input.report.status)) return;
	if (input.report.status === "accepted") {
		await AbuseRepository.transitionReportStatus({ reportId, from: "accepted", to: "resolving" });
	}
	for (const target of input.targets) {
		const resolved = await resolveTarget({
			normalizedTarget: target.normalizedTarget,
			targetType: target.targetType,
			observedUrls: target.observedUrls,
		});
		await AbuseRepository.setTargetResolution({
			targetId: target.id,
			status: resolved.status,
			resolverSnapshot: resolved.resolverSnapshot,
			disposition: resolved.disposition,
		});
		for (const routeInput of resolved.routes) {
			const route = await AbuseRepository.upsertResolvedRoute(target.id, routeInput);
			if (route.status === "resolving" && route.routeType === "skyvern_portal") {
				await AbuseRepository.enqueueJob({
					jobType: "verify_gname",
					reportId,
					routeId: route.id,
					payload: {},
					dedupeKey: `verify:${route.id.toString()}`,
				});
			} else if (route.status === "verified" && route.routeType === "email") {
				await AbuseRepository.enqueueJob({
					jobType: "send_email",
					reportId,
					routeId: route.id,
					payload: {},
					dedupeKey: `email:${route.id.toString()}`,
				});
			}
		}
	}
	await AbuseRepository.recomputeReportStatus(reportId);
}

export async function verifyGname(routeId: bigint): Promise<void> {
	const { route, report, target, evidenceArtifacts } = await routeContext(routeId);
	// Verification recaptures external evidence. A stale job must never do
	// that after the route has already been queued, submitted, or blocked.
	if (route.routeType !== "skyvern_portal" || route.providerRegistryKey !== "gname" || route.status !== "resolving") return;
	const definition = getProviderDefinition("gname");
	if (!definition || !providerDefinitionMatchesPin(definition, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "resolving", to: "needs_human", data: { reason: "provider_definition_pin_mismatch" } });
		return;
	}
	if (!isProviderRouteEnabled(definition)) {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "resolving", to: "no_route", data: { reason: "provider_route_disabled" } });
		return;
	}
	await AbuseRepository.transitionReportStatus({ reportId: report.id, from: ["resolving", "verifying"], to: "verifying" });
	const userEvidence = evidenceArtifacts.map((artifact) => ({
		filename: artifact.name,
		mimeType: artifact.mimeType as "image/jpeg" | "image/png" | "image/webp",
		buffer: artifact.blob,
		sha256: artifact.sha256,
	}));
	const result = await verifyGnameRoute({
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		legalBrandUrl: report.legalBrandUrl ?? undefined,
		description: report.description,
		userEvidence,
	});
	if (!(await AbuseRepository.setRouteVerification(route.id, result.result, gnameServiceIdentity(), "resolving"))) return;
	for (const capture of result.captures) {
		await AbuseRepository.saveArtifact({
			reportId: report.id,
			targetId: target.id,
			routeId: route.id,
			name: `capture-${new URL(capture.url).hostname}.jpg`,
			kind: "service_browser_capture",
			mimeType: capture.mimeType,
			buffer: capture.screenshot,
			metadata: capture.metadata,
		});
	}
	for (const derivative of result.derivatives) {
		await AbuseRepository.saveArtifact({
			reportId: report.id,
			targetId: target.id,
			routeId: route.id,
			name: derivative.name,
			kind: "provider_evidence_derivative",
			mimeType: derivative.mimeType,
			buffer: derivative.buffer,
			metadata: derivative.metadata,
		});
	}
	if (!result.passed) {
		const reasons = Array.isArray(result.result.reasons) ? result.result.reasons : [];
		// All GNAME preconditions, including the service identity, are evidence
		// contract requirements. `needs_human` is reserved for a material live
		// form/output drift, never for a missing configuration prerequisite.
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "resolving", to: "insufficient_evidence", data: { reasons } });
		return;
	}
	if (await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "resolving", to: "queued" })) {
		await AbuseRepository.enqueueJob({ jobType: "run_portal", reportId: report.id, routeId: route.id, payload: {}, dedupeKey: `portal:${route.id.toString()}` });
	}
}
