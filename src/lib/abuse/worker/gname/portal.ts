import { makeProviderDescription } from "../../evidence";
import { getProviderDefinition, gnameServiceIdentity, isProviderRouteEnabled, providerDefinitionMatchesPin } from "../../registry";
import { AbuseRepository } from "../../repository";
import { buildGnameTaskPayload, type AbuseSkyvernAdapter } from "../../skyvern";
import { stableJson } from "../../security";
import {
	errorText,
	envInt,
	recordValue,
	routeContext,
	storedSkyvernTaskPayload,
	UnknownExternalStateError,
	type WorkerServices,
} from "../shared";
import { gnameCodeLockKey, gnameCodeLockOwner } from "./mailbox";
import { gnameEvidenceUploadDeadline, storedGnameEvidenceSources, storedGnameEvidenceUploads, storedGnameTaskInput } from "./payload";

/** Short-lived per-route lease prevents stale workers from replaying uploads. */
function gnamePreparationLockKey(routeId: bigint): string {
	return `abuse:gname:portal-preparation:${routeId.toString()}`;
}

async function enqueueGnameReconciliation(params: {
	reportId: bigint;
	routeId: bigint;
	runId: bigint;
	skyvernRunId: string;
}): Promise<void> {
	await AbuseRepository.enqueueJob({
		jobType: "reconcile_skyvern_run",
		reportId: params.reportId,
		routeId: params.routeId,
		runId: params.runId,
		payload: { skyvernRunId: params.skyvernRunId },
		dedupeKey: `reconcile:${params.runId.toString()}:${params.skyvernRunId}`,
	});
}

export async function runGnamePortal(routeId: bigint, worker: WorkerServices): Promise<void> {
	const { route, report, target } = await routeContext(routeId);
	// Claim ownership before an SDK upload. A queued route starts an immutable
	// draft; a running route may only resume that exact draft after a safe
	// pre-task interruption. Completed/blocked routes are deliberate no-ops.
	if (route.routeType !== "skyvern_portal" || route.providerRegistryKey !== "gname" || !["queued", "running"].includes(route.status)) return;
	const definition = getProviderDefinition("gname");
	if (!definition) throw new Error("GNAME provider definition is missing.");
	if (!providerDefinitionMatchesPin(definition, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: ["queued", "running"], to: "needs_human", data: { reason: "provider_definition_pin_mismatch" } });
		return;
	}
	// Re-check the emergency kill switch immediately before any browser or
	// upload work. A queued job must honor a disable flag set after resolve.
	if (!isProviderRouteEnabled(definition)) {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: ["queued", "running"], to: "no_route", data: { reason: "provider_route_disabled" } });
		return;
	}
	const identity = gnameServiceIdentity();
	if (!identity.verified) {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: ["queued", "running"], to: "insufficient_evidence", data: { reason: "verified_service_identity_required" } });
		return;
	}
	const codeLockKey = gnameCodeLockKey(identity.mailbox);
	const codeLockOwner = gnameCodeLockOwner(route.id);
	const codeLockLeaseMs = envInt("ABUSE_GNAME_CODE_LOCK_MS", 75 * 60_000);
	const correlationKey = `portal-run:${route.id.toString()}`;
	const derivativeArtifacts = (await AbuseRepository.listArtifacts(report.id, ["provider_evidence_derivative"]))
		.filter((artifact) => artifact.routeId === route.id)
		.slice(0, definition.evidence.maximumImages);
	if (derivativeArtifacts.length === 0) {
		await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: ["queued", "running"], to: "insufficient_evidence", data: { reason: "provider_compatible_evidence_missing" } });
		return;
	}
	const taskInput = {
		entryUrl: definition.entryUrl,
		description: makeProviderDescription(report.description, target.normalizedTarget, target.observedUrls),
		domains: [target.normalizedTarget],
		observedUrls: target.observedUrls,
		serviceName: identity.name,
		legalBrandUrl: report.legalBrandUrl ?? "",
		serviceMailbox: identity.mailbox,
		webhookUrl: process.env.ABUSE_SKYVERN_WEBHOOK_URL,
		totpIdentifier: identity.mailbox,
	};
	const providerPayload = {
		adapter: "gname_category_2_v1",
		stage: "evidence_upload_pending",
		taskInput,
		contract: {
			entryUrl: definition.entryUrl,
			providerDefinitionVersion: definition.version,
			providerDefinitionHash: definition.contentHash,
			domains: [target.normalizedTarget],
			observedUrls: target.observedUrls,
			allowedFinalDomains: definition.verifiedDomains,
			declarationContract: "gname_service_declaration_v1",
		},
		sourceArtifacts: derivativeArtifacts.map((artifact) => ({
			id: artifact.id.toString(),
			name: artifact.name,
			mimeType: artifact.mimeType,
			sha256: artifact.sha256,
			size: artifact.size,
		})),
		evidenceUploads: derivativeArtifacts.map((artifact) => ({
			artifactId: artifact.id.toString(),
			sha256: artifact.sha256,
			state: "pending",
		})),
	};
	const execution = await AbuseRepository.beginGnamePortalExecution({
		routeId: route.id,
		correlationKey,
		providerPayload: route.status === "queued" ? providerPayload : undefined,
		lockKey: codeLockKey,
		lockOwner: codeLockOwner,
		lockLeaseMs: codeLockLeaseMs,
	});
	if (!execution.acquired) {
		if (execution.reason === "route_not_eligible") return;
		throw new Error("The shared GNAME verification mailbox is currently reserved by another portal run.");
	}
	let retainCodeLock = false;
	const preparationLockKey = gnamePreparationLockKey(route.id);
	const preparationLockOwner = `${worker.owner}:gname-preparation:${route.id.toString()}`;
	const preparationLockLeaseMs = envInt("ABUSE_GNAME_PREPARATION_LOCK_MS", 2 * 60_000);
	let holdsPreparationLock = false;
	const lockHeartbeat = setInterval(() => {
		void AbuseRepository.renewLock(codeLockKey, codeLockOwner, codeLockLeaseMs);
	}, Math.max(1_000, Math.floor(codeLockLeaseMs / 3)));
	let preparationHeartbeat: ReturnType<typeof setInterval> | undefined;
	try {
		// The route-owned mailbox lock intentionally has a deterministic owner so
		// it survives worker restarts. That means it cannot distinguish two stale
		// workers for the same route; this short-lived unique-owner lease does.
		if (!(await AbuseRepository.tryAcquireLock(preparationLockKey, preparationLockOwner, preparationLockLeaseMs))) {
			// Another worker owns the pre-task work. Never release the shared code
			// lock here: its deterministic route owner may belong to that worker.
			retainCodeLock = true;
			return;
		}
		holdsPreparationLock = true;
		preparationHeartbeat = setInterval(() => {
			void AbuseRepository.renewLock(preparationLockKey, preparationLockOwner, preparationLockLeaseMs);
		}, Math.max(1_000, Math.floor(preparationLockLeaseMs / 3)));

		const run = execution.run;
		if (run.skyvernRunId) {
			retainCodeLock = true;
			await enqueueGnameReconciliation({ reportId: report.id, routeId: route.id, runId: run.id, skyvernRunId: run.skyvernRunId });
			return;
		}
		if (run.executionStatus === "task_creation_started") {
			const message = "Skyvern task creation was interrupted after its durable pre-call marker; task creation will not be retried automatically.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_interrupted" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}
		if (run.executionStatus !== "starting") {
			const message = `GNAME portal run is not eligible for task preparation from ${run.executionStatus}.`;
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_portal_run_state_invalid" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}

		const persistedPayload = recordValue(run.providerPayload);
		if (!persistedPayload) {
			const message = "The persisted GNAME portal payload is malformed; automatic task creation is blocked.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_invalid" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}
		const sources = storedGnameEvidenceSources(persistedPayload);
		const input = storedGnameTaskInput(persistedPayload);
		const uploads = sources ? storedGnameEvidenceUploads(persistedPayload, sources) : undefined;
		if (!sources || !input || !uploads || !["evidence_upload_pending", "task_payload_prepared"].includes(persistedPayload.stage as string)) {
			const message = "The persisted GNAME evidence-upload draft is malformed; automatic task creation is blocked.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_draft_invalid" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}
		const artifactsById = new Map(derivativeArtifacts.map((artifact) => [artifact.id.toString(), artifact]));
		const sourceArtifacts = sources.map((source) => artifactsById.get(source.id));
		if (sourceArtifacts.some((artifact) => !artifact)) {
			const message = "A persisted GNAME evidence source is no longer available; automatic task creation is blocked.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_source_missing" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}
		for (const [index, source] of sources.entries()) {
			const artifact = sourceArtifacts[index]!;
			if (artifact.name !== source.name || artifact.mimeType !== source.mimeType || artifact.sha256 !== source.sha256 || artifact.size !== source.size) {
				const message = "Persisted GNAME evidence source metadata no longer matches its immutable artifact.";
				await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_source_metadata_changed" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
		}

		const uncertainUpload = uploads.find((upload) => upload.state === "upload_started");
		if (uncertainUpload) {
			const message = `GNAME evidence upload for artifact ${uncertainUpload.artifactId} was interrupted after its durable pre-call marker; it will not be replayed automatically.`;
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_interrupted" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}

		let taskPayload = persistedPayload.stage === "task_payload_prepared"
			? storedSkyvernTaskPayload(persistedPayload.task)
			: undefined;
		if (!taskPayload) {
			if (persistedPayload.stage !== "evidence_upload_pending") {
				const message = "The persisted GNAME task payload is malformed; automatic task creation is blocked.";
				await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_task_payload_invalid" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
			let adapter: AbuseSkyvernAdapter | undefined;
			for (const [index, source] of sources.entries()) {
				const upload = uploads[index]!;
				const artifact = sourceArtifacts[index]!;
				if (upload.state === "uploaded") continue;
				try {
					adapter ??= worker.getAdapter();
				} catch (error) {
					const message = errorText(error);
					if (await AbuseRepository.requeueGnamePortalPreparation({ runId: run.id, error: message })) {
						throw new Error(`GNAME evidence upload setup failed before an SDK call: ${message}`);
					}
					const unknown = `GNAME evidence-upload setup could not be safely reconciled: ${message}`;
					await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: unknown, reason: "gname_upload_setup_conflict" });
					retainCodeLock = true;
					throw new UnknownExternalStateError(unknown);
				}
				const preparation = await AbuseRepository.beginGnameEvidenceUpload({ runId: run.id, artifactId: source.id, sha256: source.sha256 });
				if (preparation !== "started") {
					const message = preparation === "already_started"
						? `GNAME evidence upload for artifact ${source.id} entered an ambiguous external state.`
						: `GNAME evidence upload for artifact ${source.id} could not acquire its durable pre-call marker.`;
					await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: preparation === "already_started" ? "gname_evidence_upload_interrupted" : "gname_evidence_upload_marker_conflict" });
					retainCodeLock = true;
					throw new UnknownExternalStateError(message);
				}
				let uploadedFile: { presignedUrl: string; sha256: string };
				try {
					uploadedFile = await adapter.uploadFile({ buffer: artifact.blob, filename: artifact.name, mimeType: artifact.mimeType });
				} catch (error) {
					const message = `GNAME evidence upload may have crossed the Skyvern boundary: ${errorText(error)}`;
					await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_ambiguous" });
					retainCodeLock = true;
					throw new UnknownExternalStateError(message);
				}
				if (uploadedFile.sha256 !== source.sha256) {
					const message = "Skyvern returned evidence-upload metadata that did not match the immutable source artifact.";
					await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_hash_mismatch" });
					retainCodeLock = true;
					throw new UnknownExternalStateError(message);
				}
				const expiresAt = gnameEvidenceUploadDeadline(
					uploadedFile.presignedUrl,
					new Date(),
					envInt("ABUSE_GNAME_UPLOAD_URL_MAX_AGE_MS", 10 * 60_000),
				);
				if (!(await AbuseRepository.recordGnameEvidenceUpload({
					runId: run.id,
					artifactId: source.id,
					sha256: source.sha256,
					presignedUrl: uploadedFile.presignedUrl,
					expiresAt,
				}))) {
					const message = "Skyvern evidence upload completed after its local checkpoint could no longer be recorded.";
					await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_checkpoint_conflict" });
					retainCodeLock = true;
					throw new UnknownExternalStateError(message);
				}
				uploads[index] = {
					artifactId: source.id,
					sha256: source.sha256,
					state: "uploaded",
					presignedUrl: uploadedFile.presignedUrl,
					uploadedAt: new Date().toISOString(),
					expiresAt: expiresAt.toISOString(),
				};
			}
		}

		const minimumRemainingMs = envInt("ABUSE_GNAME_UPLOAD_URL_MIN_REMAINING_MS", 60_000);
		if (uploads.some((upload) => upload.state !== "uploaded" || !upload.presignedUrl || !upload.expiresAt || Date.parse(upload.expiresAt) - Date.now() <= minimumRemainingMs)) {
			const message = "A persisted GNAME evidence-upload URL is missing or too close to expiry; automatic task creation will not re-upload evidence.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_evidence_upload_url_expired" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}
		const expectedTaskPayload = buildGnameTaskPayload({
			...input,
			presignedEvidenceUrls: uploads.map((upload) => upload.presignedUrl!),
		});
		if (taskPayload && stableJson(taskPayload) !== stableJson(expectedTaskPayload)) {
			const message = "The persisted GNAME task payload no longer matches its immutable evidence-upload contract.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_task_payload_contract_mismatch" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}
		taskPayload ??= expectedTaskPayload;
		if (persistedPayload.stage === "evidence_upload_pending") {
			const completedPayload = {
				...persistedPayload,
				stage: "task_payload_prepared",
				evidenceUploads: uploads,
				task: taskPayload,
				uploadedEvidence: uploads.map((upload) => ({ url: upload.presignedUrl, sha256: upload.sha256, artifactId: upload.artifactId })),
			};
			if (!(await AbuseRepository.prepareGnamePortalTaskPayload({ runId: run.id, providerPayload: completedPayload }))) {
				const latest = await AbuseRepository.getProviderRun(run.id);
				if (latest?.skyvernRunId) {
					retainCodeLock = true;
					await enqueueGnameReconciliation({ reportId: report.id, routeId: route.id, runId: latest.id, skyvernRunId: latest.skyvernRunId });
					return;
				}
				const message = "The GNAME task payload changed while evidence uploads were being finalized; automatic task creation is blocked.";
				await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "gname_payload_preparation_conflict" });
				retainCodeLock = true;
				throw new UnknownExternalStateError(message);
			}
		}

		if (!taskPayload) throw new Error("GNAME task payload was not prepared.");
		// Constructing the SDK adapter is local configuration work. Do it before
		// the durable pre-call marker so a missing key/base URL remains a normal
		// retryable setup failure rather than an apparent external ambiguity.
		const adapter = worker.getAdapter();
		if (!(await AbuseRepository.prepareSkyvernTaskCreation(run.id))) {
			const latest = await AbuseRepository.getProviderRun(run.id);
			if (latest?.skyvernRunId) {
				retainCodeLock = true;
				await enqueueGnameReconciliation({ reportId: report.id, routeId: route.id, runId: latest.id, skyvernRunId: latest.skyvernRunId });
				return;
			}
			const message = "Skyvern task creation could not acquire its durable pre-call marker.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_marker_conflict" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}

		let created: { runId: string };
		try {
			created = await adapter.createTask(taskPayload);
		} catch (error) {
			const message = errorText(error);
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_ambiguous" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(`Skyvern task creation was ambiguous: ${message}`);
		}
		if (!(await AbuseRepository.recordSkyvernTaskStarted({ runId: run.id, skyvernRunId: created.runId, routeStatus: "waiting_code" }))) {
			const message = "Skyvern task creation completed after the route left its expected state; operational reconciliation is required.";
			await worker.markUnknownExternal({ routeId: route.id, runId: run.id, error: message, reason: "task_creation_state_changed" });
			retainCodeLock = true;
			throw new UnknownExternalStateError(message);
		}
		retainCodeLock = true;
	} finally {
		clearInterval(lockHeartbeat);
		if (preparationHeartbeat) clearInterval(preparationHeartbeat);
		if (holdsPreparationLock) await AbuseRepository.releaseLock(preparationLockKey, preparationLockOwner);
		if (!retainCodeLock && holdsPreparationLock) await AbuseRepository.releaseLock(codeLockKey, codeLockOwner);
	}
}
