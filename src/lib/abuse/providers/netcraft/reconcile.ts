import {
	fetchNetcraftSubmissionStatus,
	netcraftSubmissionIdFromDiagnostic,
	netcraftSubmissionUrl,
	type NetcraftFetch,
} from "../../../netcraft/api";
import { AbuseRepository } from "../../repository";
import { normalizeObservedUrlForDomain } from "../report_payload";

import { NETCRAFT_PROVIDER } from "./definition";

export type NetcraftProviderReconciliationResult =
	| {
		outcome: "reconciled";
		runId: bigint;
		confirmationId: string;
		finalUrl: string;
		providerState: string;
	}
	| { outcome: "already_reconciled"; runId: bigint; confirmationId: string | null; finalUrl: string | null }
	| { outcome: "not_eligible"; reason: string };

function canonicalObservedUrls(target: { normalizedTarget: string; observedUrls: string[] }): string[] | undefined {
	const urls: string[] = [];
	for (const observedUrl of target.observedUrls) {
		const normalized = normalizeObservedUrlForDomain(observedUrl, target.normalizedTarget);
		if (!normalized || urls.includes(normalized)) return undefined;
		urls.push(normalized);
	}
	return urls.length > 0 ? urls : undefined;
}

function confirmationText(state: string): string {
	const normalized = state.trim().toLowerCase();
	if (normalized === "processing") return "Netcraft accepted the report and is processing the submitted URL.";
	if (normalized === "malicious" || normalized === "suspicious" || normalized === "no threats") {
		return "Netcraft accepted the report and completed its current URL analysis.";
	}
	return "Netcraft accepted the report; its current URL analysis state is available from Netcraft.";
}

/**
 * Reconcile an ambiguous Netcraft POST with a verified, read-only provider
 * receipt. This never retries the report. It permits a state transition only
 * when the submitted URL set returned by Netcraft contains every durable route
 * URL and the persisted run is still exactly `unknown_external_state`.
 */
export async function reconcileNetcraftProviderRun(params: {
	runId: bigint;
	submissionId: string;
	fetch?: NetcraftFetch;
}): Promise<NetcraftProviderReconciliationResult> {
	let suppliedFinalUrl: string;
	try {
		suppliedFinalUrl = netcraftSubmissionUrl(params.submissionId);
	} catch {
		return { outcome: "not_eligible", reason: "netcraft_submission_id_invalid" };
	}

	const run = await AbuseRepository.getProviderRun(params.runId);
	if (!run) return { outcome: "not_eligible", reason: "provider_run_not_found" };
	const route = await AbuseRepository.getRoute(run.routeId);
	if (!route || route.providerRegistryKey !== NETCRAFT_PROVIDER.key) return { outcome: "not_eligible", reason: "netcraft_route_not_found" };

	if (route.status === "submitted" && run.executionStatus === "completed") {
		return {
			outcome: "already_reconciled",
			runId: run.id,
			confirmationId: run.confirmationId,
			finalUrl: run.finalUrl,
		};
	}
	if (route.status !== "unknown_external_state" || run.executionStatus !== "unknown_external_state") {
		return { outcome: "not_eligible", reason: "provider_run_not_unresolved" };
	}

	const diagnosticId = netcraftSubmissionIdFromDiagnostic(run.failureReason ?? "");
	if (diagnosticId !== undefined && netcraftSubmissionUrl(diagnosticId) !== suppliedFinalUrl) {
		return { outcome: "not_eligible", reason: "netcraft_submission_id_diagnostic_mismatch" };
	}

	const target = await AbuseRepository.getTarget(route.targetId);
	if (!target || target.targetType !== "domain") return { outcome: "not_eligible", reason: "netcraft_target_not_found" };
	const expectedUrls = canonicalObservedUrls(target);
	if (!expectedUrls) return { outcome: "not_eligible", reason: "netcraft_expected_urls_invalid" };

	const receipt = await fetchNetcraftSubmissionStatus({ uuid: params.submissionId, ...(params.fetch ? { fetch: params.fetch } : {}) });
	if (!receipt.hasUrls) return { outcome: "not_eligible", reason: "netcraft_receipt_has_no_urls" };
	const receivedUrls = new Set(
		receipt.urls
			.map((entry) => normalizeObservedUrlForDomain(entry.url, target.normalizedTarget))
			.filter((url): url is string => Boolean(url)),
	);
	if (expectedUrls.some((url) => !receivedUrls.has(url))) {
		return { outcome: "not_eligible", reason: "netcraft_receipt_target_mismatch" };
	}

	const reconciled = await AbuseRepository.reconcileProviderRun({
		runId: run.id,
		providerRegistryKey: NETCRAFT_PROVIDER.key,
		confirmationId: receipt.uuid,
		confirmationText: confirmationText(receipt.state),
		finalUrl: netcraftSubmissionUrl(receipt.uuid),
		submittedTargets: [target.normalizedTarget],
		reconciliationReason: "netcraft_verified_submission_receipt",
	});
	if (!reconciled) {
		const currentRun = await AbuseRepository.getProviderRun(run.id);
		const currentRoute = await AbuseRepository.getRoute(route.id);
		if (currentRun?.executionStatus === "completed" && currentRoute?.status === "submitted") {
			return {
				outcome: "already_reconciled",
				runId: currentRun.id,
				confirmationId: currentRun.confirmationId,
				finalUrl: currentRun.finalUrl,
			};
		}
		return { outcome: "not_eligible", reason: "netcraft_reconciliation_state_conflict" };
	}

	return {
		outcome: "reconciled",
		runId: run.id,
		confirmationId: receipt.uuid,
		finalUrl: netcraftSubmissionUrl(receipt.uuid),
		providerState: receipt.state,
	};
}
