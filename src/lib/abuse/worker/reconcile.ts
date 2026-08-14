import { AbuseRepository } from "../repository";
import {
	isTerminalSkyvernStatus,
	validateGenericProviderFormOutput,
	type SkyvernOutputContract,
} from "../skyvern";
import { stableJson } from "../security";

import type { WorkerServices } from "./shared";

export type SkyvernRunOutputValidator = (params: {
	output: Record<string, unknown>;
	providerPayload: Record<string, unknown>;
}) => SkyvernOutputContract;

/**
 * Reconcile one Skyvern run using a code-owned output validator. Provider
 * resource fencing lives in the provider wrapper; this shared transport path
 * contains no provider-specific lifecycle policy.
 */
export async function reconcileSkyvernRun(
	runId: bigint,
	worker: Pick<WorkerServices, "getAdapter" | "markUnknownExternal">,
	validateOutput: SkyvernRunOutputValidator,
): Promise<void> {
	const run = await AbuseRepository.getProviderRun(runId);
	if (!run || !run.skyvernRunId) return;
	const route = await AbuseRepository.getRoute(run.routeId);
	if (!route) return;
	// Replayed webhooks and stale poll jobs must not re-read a terminal run
	// and turn a previously successful route into a failure because output or
	// artifacts are no longer returned by Skyvern.
	if (["submitted", "acknowledged", "provider_rejected", "delivery_failed", "insufficient_evidence", "no_route", "failed", "needs_human", "unknown_external_state"].includes(route.status)) return;
	// Missing local configuration or a bootstrap sidecar that is still
	// writing its key means no external request occurred. Let the durable
	// job retry normally; only SDK calls below can cross the ambiguity line.
	const adapter = worker.getAdapter();
	const result = await adapter.reconcileRun({
		runId: run.skyvernRunId,
		reportId: run.reportId,
		routeId: run.routeId,
		providerKey: route.providerRegistryKey,
		localRunId: run.id,
	});
	if (!isTerminalSkyvernStatus(result.status)) {
		await AbuseRepository.enqueueJob({
			jobType: "reconcile_skyvern_run",
			reportId: run.reportId,
			routeId: run.routeId,
			runId: run.id,
			payload: { skyvernRunId: run.skyvernRunId },
			// The current job is still running until processJob returns. Give
			// each future poll a unique durable key instead of self-deduping.
			dedupeKey: `reconcile:${run.id.toString()}:${run.skyvernRunId}:${Date.now()}`,
			nextAttemptAt: new Date(Date.now() + 15_000),
		});
		return;
	}
	const output = result.output ?? {};
	await AbuseRepository.saveArtifact({
		reportId: run.reportId,
		routeId: run.routeId,
		runId: run.id,
		name: `skyvern-output-${run.skyvernRunId}.json`,
		kind: "skyvern_extracted_output",
		mimeType: "application/json",
		buffer: Buffer.from(stableJson(output), "utf8"),
		metadata: { providerKey: route.providerRegistryKey, skyvernRunId: run.skyvernRunId, status: result.status ?? "unknown" },
	});
	const contract = validateOutput({ output, providerPayload: run.providerPayload });
	const completed = result.status === "completed";
	const routeStatus = completed && contract.passed && !result.failureReason
		? "submitted"
		: completed
			? "needs_human"
			: "failed";
	await AbuseRepository.settleSkyvernRun({
		runId: run.id,
		executionStatus: completed ? "completed" : result.status === "canceled" ? "canceled" : "failed",
		routeStatus,
		confirmationId: completed && contract.passed ? contract.confirmationId : undefined,
		confirmationText: completed && contract.passed ? contract.confirmationText : undefined,
		finalUrl: completed && contract.passed ? contract.finalUrl : undefined,
		submittedTargets: completed && contract.passed ? contract.submittedTargets : [],
		failureReason: result.failureReason ?? (contract.passed ? undefined : contract.reason),
		routeData: { reason: output.form_drift === true ? contract.reason ?? "provider_form_drift" : contract.reason },
	});
}

export async function reconcileGenericSkyvern(
	runId: bigint,
	worker: Pick<WorkerServices, "getAdapter" | "markUnknownExternal">,
): Promise<void> {
	return reconcileSkyvernRun(runId, worker, ({ output, providerPayload }) =>
		validateGenericProviderFormOutput({ output, providerPayload }),
	);
}
