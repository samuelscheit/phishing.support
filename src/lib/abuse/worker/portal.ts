import crypto from "node:crypto";

import { resolveVerifiedProviderLink } from "../mail";
import { gnameServiceIdentity, isGenericFormEscalationEnabled, verifiedDomainsForEmailRoute } from "../registry";
import { AbuseRepository } from "../repository";
import { buildGenericProviderFormTaskPayload, isTerminalSkyvernStatus, validateSkyvernOutputContract, type SkyvernTaskPayload } from "../skyvern";
import { stableJson } from "../security";
import { gnameCodeLockKey, gnameCodeLockOwner } from "./gname/mailbox";
import { errorText, envInt, recordValue, routeContext, storedSkyvernTaskPayload, UnknownExternalStateError, type WorkerServices } from "./shared";

/**
 * Unlike the GNAME mailbox lock, generic portals do not share a physical
 * resource. They still need a unique owner around task creation so a stale
 * job cannot mistake a live worker's durable pre-call marker for a crash.
 */
function portalTaskCreationLockKey(routeId: bigint): string {
	return `abuse:portal-task-creation:${routeId.toString()}`;
}

export async function runGenericProviderPortal(routeId: bigint, payload: Record<string, unknown>, worker: WorkerServices): Promise<void> {
	const { route, report, target } = await routeContext(routeId);
	// A public link can start this adapter only from the explicit
	// not-monitored escalation transition. A `running` route is a replay of
	// the exact immutable payload already persisted by that transition.
	if (!["escalating_to_portal", "running"].includes(route.status)) return;
	if (route.routeType !== "email" || !route.verifiedEmail) throw new Error("Generic portal escalation requires a verified email route.");
	if (route.status === "escalating_to_portal" && !isGenericFormEscalationEnabled()) {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "escalating_to_portal", to: "provider_rejected", data: { reason: "generic_form_escalation_disabled" } });
		return;
	}
	let correlationKey: string;
	let providerPayload: Record<string, unknown>;
	let taskPayload: SkyvernTaskPayload | undefined;
	if (route.status === "escalating_to_portal") {
		const providerLink = typeof payload.providerLink === "string" ? payload.providerLink : undefined;
		if (!providerLink) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "escalating_to_portal", to: "provider_rejected", data: { reason: "generic_provider_link_missing" } });
			return;
		}
		const verifiedDomains = verifiedDomainsForEmailRoute(route.verifiedEmail);
		const resolvedEntryUrl = await resolveVerifiedProviderLink({ candidate: providerLink, verifiedDomains });
		if (!resolvedEntryUrl) {
			await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "escalating_to_portal", to: "provider_rejected", data: { reason: "generic_provider_link_origin_changed" } });
			return;
		}
		const entryUrl = new URL(resolvedEntryUrl);
		taskPayload = buildGenericProviderFormTaskPayload({
			entryUrl: entryUrl.toString(),
			allowedDomains: verifiedDomains,
			target: target.normalizedTarget,
			allegationCategory: report.allegationCategory,
			description: report.description,
			observedUrls: target.observedUrls,
			legalBrandUrl: report.legalBrandUrl ?? undefined,
			reporterContactEmail: report.reporterContactEmail ?? undefined,
			webhookUrl: process.env.ABUSE_SKYVERN_WEBHOOK_URL,
		});
		correlationKey = `generic-portal:${route.id.toString()}:${crypto.createHash("sha256").update(entryUrl.toString()).digest("hex").slice(0, 24)}`;
		providerPayload = {
			adapter: "generic_verified_provider_form",
			entryUrl: entryUrl.toString(),
			verifiedDomains,
			task: taskPayload,
			contract: {
				entryUrl: entryUrl.toString(),
				target: target.normalizedTarget,
				observedUrls: target.observedUrls,
				allowedFinalDomains: verifiedDomains,
			},
		};
	} else {
		const priorRun = await AbuseRepository.getLatestProviderRunForRoute(route.id);
		const priorPayload = priorRun && recordValue(priorRun.providerPayload);
		if (!priorRun || !priorPayload || priorPayload.adapter !== "generic_verified_provider_form") {
			const message = "A running generic provider-form route has no valid durable task payload.";
			await worker.markUnknownExternal({ routeId: route.id, error: message, reason: "generic_portal_run_missing" });
			throw new UnknownExternalStateError(message);
		}
		correlationKey = priorRun.correlationKey;
		providerPayload = priorPayload;
		taskPayload = storedSkyvernTaskPayload(priorPayload.task);
		if (!taskPayload) {
			const message = "The persisted generic provider-form task payload is malformed.";
			await worker.markUnknownExternal({ routeId: route.id, runId: priorRun.id, error: message, reason: "generic_portal_payload_invalid" });
			throw new UnknownExternalStateError(message);
		}
	}
	const taskCreationLockKey = portalTaskCreationLockKey(route.id);
	const taskCreationLockOwner = `${worker.owner}:portal-task-creation:${route.id.toString()}`;
	const taskCreationLockLeaseMs = envInt("ABUSE_PORTAL_TASK_CREATION_LOCK_MS", 5 * 60_000);
	if (!(await AbuseRepository.tryAcquireLock(taskCreationLockKey, taskCreationLockOwner, taskCreationLockLeaseMs))) {
		// A live worker owns this route's durable pre-call boundary. Its job
		// will either persist the Skyvern ID or leave the pre-call marker for a
		// later recovery. Never turn that live ownership into a false ambiguity.
		return;
	}
	const lockHeartbeat = setInterval(() => {
		void AbuseRepository.renewLock(taskCreationLockKey, taskCreationLockOwner, taskCreationLockLeaseMs);
	}, Math.max(1_000, Math.floor(taskCreationLockLeaseMs / 3)));
	try {
		// Adapter construction is local configuration validation. Do it before
		// creating a run marker so missing credentials or a booting sidecar are
		// ordinary retryable failures, not external-state ambiguities.
		const adapter = worker.getAdapter();
		const execution = await AbuseRepository.beginPortalExecution({
			routeId: route.id,
			correlationKey,
			providerPayload,
			expectedStatus: "escalating_to_portal",
		});
		if (!execution) return;
		const run = execution.run;
		if (run.skyvernRunId) {
			await AbuseRepository.enqueueJob({
				jobType: "reconcile_skyvern_run",
				reportId: report.id,
				routeId: route.id,
				runId: run.id,
				payload: { skyvernRunId: run.skyvernRunId },
				dedupeKey: `reconcile:${run.id.toString()}:${run.skyvernRunId}`,
			});
			return;
		}
		if (run.executionStatus === "task_creation_started") {
			const message = "Generic provider-form task creation was interrupted after its durable pre-call marker; it will not be retried automatically.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_interrupted" });
			throw new UnknownExternalStateError(message);
		}
		if (run.executionStatus !== "starting") {
			const message = `Generic provider-form run is not eligible for task creation from ${run.executionStatus}.`;
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "generic_portal_run_state_invalid" });
			throw new UnknownExternalStateError(message);
		}
		const durableTaskPayload = storedSkyvernTaskPayload(recordValue(run.providerPayload)?.task);
		if (!durableTaskPayload) {
			const message = "The generic provider-form task payload could not be recovered from durable storage.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "generic_portal_payload_missing" });
			throw new UnknownExternalStateError(message);
		}
		if (!(await AbuseRepository.prepareSkyvernTaskCreation(run.id))) {
			const latest = await AbuseRepository.getProviderRun(run.id);
			if (latest?.skyvernRunId) {
				await AbuseRepository.enqueueJob({
					jobType: "reconcile_skyvern_run",
					reportId: report.id,
					routeId: route.id,
					runId: latest.id,
					payload: { skyvernRunId: latest.skyvernRunId },
					dedupeKey: `reconcile:${latest.id.toString()}:${latest.skyvernRunId}`,
				});
				return;
			}
			const message = "Generic provider-form task creation could not acquire its durable pre-call marker.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_marker_conflict" });
			throw new UnknownExternalStateError(message);
		}
		let created: { runId: string };
		try {
			created = await adapter.createTask(durableTaskPayload);
		} catch (error) {
			const message = errorText(error);
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_ambiguous" });
			throw new UnknownExternalStateError(`Generic provider form task creation was ambiguous: ${message}`);
		}
		if (!(await AbuseRepository.recordSkyvernTaskStarted({ runId: run.id, skyvernRunId: created.runId, routeStatus: "running" }))) {
			const message = "Skyvern task creation completed after the route left its expected state; operational reconciliation is required.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_state_changed" });
			throw new UnknownExternalStateError(message);
		}
	} finally {
		clearInterval(lockHeartbeat);
		await AbuseRepository.releaseLock(taskCreationLockKey, taskCreationLockOwner);
	}
}

export async function reconcileSkyvern(runId: bigint, worker: Pick<WorkerServices, "getAdapter" | "markUnknownExternal">): Promise<void> {
	const run = await AbuseRepository.getProviderRun(runId);
	if (!run || !run.skyvernRunId) return;
	const route = await AbuseRepository.getRoute(run.routeId);
	if (!route) return;
	// Replayed webhooks and stale poll jobs must not re-read a terminal run
	// and turn a previously successful route into a failure because output or
	// artifacts are no longer returned by Skyvern.
	if (["submitted", "acknowledged", "provider_rejected", "delivery_failed", "insufficient_evidence", "no_route", "failed", "needs_human", "unknown_external_state"].includes(route.status)) return;
	const isGname = route.providerRegistryKey === "gname";
	const identity = isGname ? gnameServiceIdentity() : undefined;
	const lockKey = identity?.mailbox ? gnameCodeLockKey(identity.mailbox) : undefined;
	const lockOwner = isGname ? gnameCodeLockOwner(route.id) : undefined;
	const lockLeaseMs = envInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000);
	let lockHeartbeat: ReturnType<typeof setInterval> | undefined;
	if (lockKey && lockOwner) {
		// Reconciliation must renew the lock we already acquired during task
		// creation. Re-acquiring an expired lock would be unsafe: another route
		// could have consumed the shared mailbox's next code in the meantime.
		if (!(await AbuseRepository.renewLock(lockKey, lockOwner, lockLeaseMs))) {
			const message = "The shared GNAME mailbox lock was lost while the external run was active; automatic reconciliation is blocked.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_mailbox_lock_lost" });
			throw new UnknownExternalStateError(message);
		}
		lockHeartbeat = setInterval(() => {
			void AbuseRepository.renewLock(lockKey, lockOwner, lockLeaseMs);
		}, Math.max(1_000, Math.floor(lockLeaseMs / 3)));
	}
	try {
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
		const contract = validateSkyvernOutputContract({
			output,
			providerKey: route.providerRegistryKey,
			providerPayload: run.providerPayload,
		});
		const completed = result.status === "completed";
		const routeStatus = completed && contract.passed && !result.failureReason
			? "submitted"
			: completed
				? "needs_human"
				: "failed";
		const settled = await AbuseRepository.settleSkyvernRun({
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
		if (!settled) return;
	} finally {
		if (lockHeartbeat) clearInterval(lockHeartbeat);
		if (lockKey && lockOwner) {
			const finalRun = await AbuseRepository.getProviderRun(run.id);
			const terminal = finalRun && ["completed", "failed", "canceled"].includes(finalRun.executionStatus);
			if (terminal) await AbuseRepository.releaseLock(lockKey, lockOwner);
		}
	}
}
