
import { resolveVerifiedProviderLink } from "../mail/reply";
import { verifiedDomainsForEmailRoute } from "../providers/email";
import { serviceIdentity } from "../../network/service_identity";
import { reportAccessOf } from "../providers/kit/draft";
import { deriveProviderFormFacts } from "../portal/form_facts";
import { validateGenericProviderFormOutput } from "../portal/output_validation";
import { buildGenericProviderFormPayload, GENERIC_PROVIDER_FORM_EVIDENCE_CONTRACT, storedGenericProviderFormEvidence } from "../portal/form_task";
import { GENERIC_PROVIDER_FORM_ADAPTER } from "../providers/generic_form";
import { loadEvidenceFile, selectProviderEvidenceImageArtifacts } from "../providers/kit/evidence";
import { AbuseRepository } from "../repository";
import { agentGaveUp, type TaskResult } from "../../browser/task/agent";
import { runFabricBrowserTask } from "../../browser/task/fabric";
import { redactedErrorText } from "../../util/error_text";
import { routeContext, storedBrowserTask, throwIfAborted, UnknownExternalStateError, type WorkerServices } from "./shared";
import { asRecord } from "../../util/values";
import { stableJson, sha256Hex } from "../../util/hash";

/**
 * Wall-clock limit of one provider-form task. It must end before the
 * external job's deadline (10 minutes by default) so a slow form settles as a
 * failed run instead of a fenced job.
 */
const PORTAL_TASK_TIMEOUT_MS = 8 * 60_000;
const PORTAL_TASK_LOCK_MS = 5 * 60_000;

/**
 * Generic email-form portals do not share a provider-managed resource. They
 * still need a unique owner around the task so a stale job cannot mistake a
 * live worker's durable task marker for a crash.
 */
function portalTaskLockKey(routeId: bigint): string {
	return `abuse:portal-task:${routeId.toString()}`;
}

/** What one task run did, as stored evidence: never the model's prompt, only its outcome and steps. */
function taskRecord(result: TaskResult): Record<string, unknown> {
	return {
		status: result.status,
		summary: result.summary,
		...(result.question ? { question: result.question } : {}),
		...(result.result !== undefined ? { result: result.result } : {}),
		...(result.url ? { finalUrl: result.url } : {}),
		usage: result.usage,
		steps: result.steps.map((step) => ({
			step: step.step,
			url: step.url,
			title: step.title,
			thought: step.thought,
			actions: step.actions,
			durationMs: step.durationMs,
		})),
	};
}

/**
 * How a finished task settles its run and route. Only a `done` result whose
 * submission contract passes is a submitted report; a result that fails the
 * contract, or an agent that needs something it does not have (a login, a
 * verification code), goes to a person; anything else failed.
 */
type Settlement = Omit<Parameters<typeof AbuseRepository.settleProviderRun>[0], "runId">;

function settlement(result: TaskResult, providerPayload: Record<string, unknown>): Settlement {
	if (result.status === "done") {
		const output = asRecord(result.result) ?? {};
		const contract = validateGenericProviderFormOutput({ output, providerPayload });
		if (contract.passed) {
			return {
				executionStatus: "completed",
				routeStatus: "submitted",
				confirmationId: contract.confirmationId,
				confirmationText: contract.confirmationText,
				finalUrl: contract.finalUrl,
				submittedTargets: contract.submittedTargets,
			};
		}
		return {
			executionStatus: "completed",
			routeStatus: "needs_human",
			failureReason: contract.reason,
			routeData: { reason: output.form_drift === true ? contract.reason ?? "provider_form_drift" : contract.reason },
		};
	}
	if (result.status === "needs_input") {
		return {
			executionStatus: "failed",
			routeStatus: "needs_human",
			failureReason: `The agent needs input: ${result.question ?? result.summary}`.slice(0, 2_000),
			routeData: { reason: "browser_task_needs_input" },
		};
	}
	return {
		executionStatus: "failed",
		routeStatus: "failed",
		failureReason: redactedErrorText(`${result.status}: ${result.summary}`),
		routeData: { reason: agentGaveUp(result) ? "browser_task_gave_up" : `browser_task_${result.status}` },
	};
}

/**
 * Each escalation is its own run: a route a person sent back to the form
 * after a run that never submitted gets a fresh key, while a replay of the
 * same escalation (before its run exists) computes the same key again.
 */
export async function genericPortalCorrelationKey(route: { id: bigint; reportId: bigint }, entryUrl: string): Promise<string> {
	const priorRuns = (await AbuseRepository.listProviderRunsForReport(route.reportId))
		.filter((run) => run.routeId === route.id && run.correlationKey.startsWith("generic-portal:"));
	return `generic-portal:${route.id.toString()}:${sha256Hex(entryUrl).slice(0, 24)}${priorRuns.length ? `:${priorRuns.length + 1}` : ""}`;
}

export async function runGenericProviderPortal(routeId: bigint, payload: Record<string, unknown>, worker: WorkerServices): Promise<void> {
	const routeData = await routeContext(routeId);
	const { route, report, target, evidenceArtifacts } = routeData;
	// A public link can start this adapter only from the explicit
	// not-monitored escalation transition. A `running` route is a replay of
	// the exact immutable payload already persisted by that transition.
	if (!["escalating_to_portal", "running"].includes(route.status)) return;
	if (route.routeType !== "email" || !route.verifiedEmail) throw new Error("Generic portal escalation requires a verified email route.");
	let correlationKey: string;
	let providerPayload: Record<string, unknown>;
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
		const analysisFacts = await deriveProviderFormFacts({
			target: target.normalizedTarget,
			analysis: report.description,
			...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		});
		correlationKey = await genericPortalCorrelationKey(route, entryUrl.toString());
		providerPayload = buildGenericProviderFormPayload({
			entryUrl: entryUrl.toString(),
			allowedDomains: verifiedDomains,
			target: target.normalizedTarget,
			allegationCategory: report.allegationCategory,
			description: report.description,
			observedUrls: target.observedUrls,
			legalBrandUrl: report.legalBrandUrl ?? undefined,
			reporter: { name: serviceIdentity.name, organization: serviceIdentity.name, website: serviceIdentity.url, email: serviceIdentity.mailbox },
			observedAt: report.createdAt,
			analysisFacts,
			...reportAccessOf(routeData),
			evidence: selectProviderEvidenceImageArtifacts(evidenceArtifacts, GENERIC_PROVIDER_FORM_EVIDENCE_CONTRACT, GENERIC_PROVIDER_FORM_ADAPTER.evidence.maximumFiles),
		});
	} else {
		const priorRun = await AbuseRepository.getLatestProviderRunForRoute(route.id);
		const priorPayload = priorRun && asRecord(priorRun.providerPayload);
		if (!priorRun || !priorPayload || priorPayload.adapter !== "generic_verified_provider_form") {
			const message = "A running generic provider-form route has no valid durable task payload.";
			await worker.markUnknownExternal({ routeId: route.id, error: message, reason: "generic_portal_run_missing" });
			throw new UnknownExternalStateError(message);
		}
		correlationKey = priorRun.correlationKey;
		providerPayload = priorPayload;
	}
	const lockKey = portalTaskLockKey(route.id);
	const lockOwner = `${worker.owner}:portal-task:${route.id.toString()}`;
	if (!(await AbuseRepository.tryAcquireLock(lockKey, lockOwner, PORTAL_TASK_LOCK_MS))) {
		// A live worker owns this route's task. Its job either settles the run
		// or leaves the durable task marker for a later recovery. Never turn
		// that live ownership into a false ambiguity.
		return;
	}
	const lockHeartbeat = setInterval(() => {
		void AbuseRepository.renewLock(lockKey, lockOwner, PORTAL_TASK_LOCK_MS);
	}, Math.max(1_000, Math.floor(PORTAL_TASK_LOCK_MS / 3)));
	try {
		// The model is local configuration. Resolve it before the run marker
		// exists, so a missing key is an ordinary retryable failure, not an
		// external-state ambiguity.
		const model = worker.browserTaskModel();
		const execution = await AbuseRepository.beginProviderExecution({
			routeId: route.id,
			correlationKey,
			providerPayload,
			expectedStatus: "escalating_to_portal",
		});
		if (!execution) return;
		const run = execution.run;
		if (run.executionStatus === "task_started") {
			const message = "A generic provider-form task was interrupted after it started; the form may have been submitted, so it is not run again.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "browser_task_interrupted" });
			throw new UnknownExternalStateError(message);
		}
		if (run.executionStatus !== "starting") {
			const message = `Generic provider-form run is not eligible for a browser task from ${run.executionStatus}.`;
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "generic_portal_run_state_invalid" });
			throw new UnknownExternalStateError(message);
		}
		const storedPayload = asRecord(run.providerPayload);
		const task = storedBrowserTask(storedPayload?.task);
		const evidence = storedGenericProviderFormEvidence(storedPayload?.evidence);
		if (!task || !evidence) {
			const message = "The generic provider-form task could not be recovered from durable storage.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "generic_portal_payload_invalid" });
			throw new UnknownExternalStateError(message);
		}
		// The stored references are re-checked against the artifacts' bytes
		// before they can cross to the provider; a changed artifact stops here.
		const files = await Promise.all(evidence.map(async (reference) => {
			const { bytes } = await loadEvidenceFile({ reference, contract: GENERIC_PROVIDER_FORM_EVIDENCE_CONTRACT, reportId: run.reportId, label: "generic provider-form" });
			return { filename: reference.filename, mimeType: reference.mimeType, bytes };
		}));
		throwIfAborted(worker.signal);
		const result = await runFabricBrowserTask({
			task,
			files,
			model,
			// Provider portals are reporting traffic: direct egress, never the Tor phishing exit.
			egress: "reporting",
			metadata: {
				operation: "provider-form",
				provider: "generic-verified-provider-form",
				reportId: report.id.toString(),
				routeId: route.id.toString(),
				runId: run.id.toString(),
			},
			timeoutMs: PORTAL_TASK_TIMEOUT_MS,
			started: (fabricSessionId) => AbuseRepository.startBrowserTask({ runId: run.id, fabricSessionId }),
			acquire: worker.acquireBrowserSession,
			...(worker.signal ? { signal: worker.signal } : {}),
		});
		if (!result) {
			const message = "The generic provider-form run left its starting state before its browser task began.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "browser_task_marker_conflict" });
			throw new UnknownExternalStateError(message);
		}
		// An aborted run stopped mid-task: the worker fences it as unknown.
		throwIfAborted(worker.signal);
		const settled = await AbuseRepository.getProviderRun(run.id);
		const settledPayload = asRecord(settled?.providerPayload) ?? run.providerPayload;
		await AbuseRepository.saveArtifact({
			reportId: run.reportId,
			routeId: run.routeId,
			runId: run.id,
			name: `browser-task-${run.id.toString()}.json`,
			kind: "browser_task_record",
			mimeType: "application/json",
			buffer: Buffer.from(stableJson(taskRecord(result)), "utf8"),
			metadata: { providerKey: route.providerRegistryKey, status: result.status, model: model.id },
		});
		await AbuseRepository.settleProviderRun({ runId: run.id, ...settlement(result, settledPayload) });
	} finally {
		clearInterval(lockHeartbeat);
		await AbuseRepository.releaseLock(lockKey, lockOwner);
	}
}
