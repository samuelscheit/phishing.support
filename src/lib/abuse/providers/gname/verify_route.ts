import { saveArtifact } from "../../persistence/artifacts";
import { enqueueJob } from "../../persistence/jobs";
import { transitionReportStatus } from "../../persistence/reports";
import { setRouteVerification, transitionRouteStatus } from "../../persistence/routes";
import { routeContext } from "../../worker/shared";

import { gnameServiceIdentity, isGnameEnabled } from "./config";
import { GNAME_PROVIDER } from "./definition";
import { gnameDefinitionMatchesPin } from "./definition_integrity";
import { verifyGnameRoute } from "./verification";

/**
 * Own the GNAME verification transition, including fresh evidence capture,
 * provider-specific eligibility, and the route's next portal job.
 */
export async function verifyGnameProviderRoute(routeId: bigint): Promise<void> {
	const { route, report, target, evidenceArtifacts } = await routeContext(routeId);
	// Verification can recapture external evidence. A stale job must never do
	// that after this route has advanced or reached a terminal state.
	if (route.routeType !== "skyvern_portal" || route.providerRegistryKey !== GNAME_PROVIDER.key || route.status !== "resolving") return;
	if (!gnameDefinitionMatchesPin(GNAME_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		await transitionRouteStatus({
			routeId: route.id,
			from: "resolving",
			to: "needs_human",
			data: { reason: "provider_definition_pin_mismatch" },
		});
		return;
	}
	if (!isGnameEnabled()) {
		await transitionRouteStatus({
			routeId: route.id,
			from: "resolving",
			to: "no_route",
			data: { reason: "provider_route_disabled" },
		});
		return;
	}

	await transitionReportStatus({ reportId: report.id, from: ["resolving", "verifying"], to: "verifying" });
	const result = await verifyGnameRoute({
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		legalBrandUrl: report.legalBrandUrl ?? undefined,
		description: report.description,
		userEvidence: evidenceArtifacts.map((artifact) => ({
			filename: artifact.name,
			mimeType: artifact.mimeType as "image/jpeg" | "image/png" | "image/webp",
			buffer: artifact.blob,
			sha256: artifact.sha256,
		})),
	});
	if (!(await setRouteVerification(route.id, result.result, gnameServiceIdentity(), "resolving"))) return;

	for (const capture of result.captures) {
		await saveArtifact({
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
		await saveArtifact({
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
		await transitionRouteStatus({
			routeId: route.id,
			from: "resolving",
			to: "insufficient_evidence",
			data: { reasons },
		});
		return;
	}
	if (await transitionRouteStatus({ routeId: route.id, from: "resolving", to: "queued" })) {
		await enqueueJob({
			jobType: "run_portal",
			reportId: report.id,
			routeId: route.id,
			payload: {},
			dedupeKey: `portal:${route.id.toString()}`,
		});
	}
}
