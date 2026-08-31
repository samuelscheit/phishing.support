import { AbuseRepository } from "../repository";
import { hashStableJson } from "../security";

import { providerDefinitionMatchesPin } from "./definition";

import {
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionProvider,
	type ProviderSubmissionSuccess,
} from "./submission_contracts";

export type ProviderSubmissionExecutionResult =
	| { outcome: "submitted"; runId: bigint }
	| { outcome: "provider_rejected"; runId?: bigint; reason: string }
	| { outcome: "insufficient_evidence"; reason: string }
	| { outcome: "not_eligible" };

/**
 * Signals to the job runner that an irreversible provider request may have
 * happened but could not be durably settled. Replaying the job would risk
 * filing the same complaint twice.
 */
export class ProviderSubmissionUnknownExternalStateError extends Error {
	readonly unknownExternalState = true;

	constructor(message: string) {
		super(message);
		this.name = "ProviderSubmissionUnknownExternalStateError";
	}
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPreparation(value: unknown): value is ProviderSubmissionPreparation {
	if (!isRecord(value) || typeof value.outcome !== "string") return false;
	if (value.outcome === "ready") return isRecord(value.payload);
	return value.outcome === "insufficient_evidence" && typeof value.reason === "string" && value.reason.trim().length > 0;
}

function isSubmissionSuccess(value: unknown): value is ProviderSubmissionSuccess {
	if (!isRecord(value)) return false;
	if (value.confirmationId !== undefined && typeof value.confirmationId !== "string") return false;
	if (value.confirmationText !== undefined && typeof value.confirmationText !== "string") return false;
	if (value.finalUrl !== undefined && typeof value.finalUrl !== "string") return false;
	return Array.isArray(value.submittedTargets)
		&& value.submittedTargets.length > 0
		&& value.submittedTargets.every((target) => typeof target === "string" && target.trim().length > 0);
}

function correlationKey(provider: ProviderSubmissionProvider, routeId: bigint): string {
	return `provider-submission:${provider.definition.key}:${routeId.toString()}`;
}

/** Cleanup must never rewrite the provider outcome after an external call. */
async function disposePreflight(preflight: ProviderSubmissionPreflight | undefined): Promise<void> {
	if (!preflight?.dispose) return;
	try {
		await preflight.dispose();
	} catch (error) {
		console.warn("Provider submission preflight cleanup failed:", error);
	}
}

async function markUnknownExternal(params: { routeId: bigint; runId?: bigint; error: string; reason: string }): Promise<never> {
	await AbuseRepository.markUnknownExternalState(params);
	throw new ProviderSubmissionUnknownExternalStateError(params.error);
}

async function settleKnownRejection(params: {
	routeId: bigint;
	runId?: bigint;
	reason: string;
}): Promise<ProviderSubmissionExecutionResult> {
	if (params.runId === undefined) {
		const changed = await AbuseRepository.transitionRouteStatus({
			routeId: params.routeId,
			from: ["queued", "verified"],
			to: "provider_rejected",
			data: { reason: params.reason },
		});
		if (changed || (await AbuseRepository.getRoute(params.routeId))?.status === "provider_rejected") {
			return { outcome: "provider_rejected", reason: params.reason };
		}
		return { outcome: "not_eligible" };
	}

	let settled: boolean;
	try {
		settled = await AbuseRepository.settleProviderRun({
			runId: params.runId,
			executionStatus: "failed",
			routeStatus: "provider_rejected",
			failureReason: params.reason,
			routeData: { reason: params.reason },
		});
	} catch (error) {
		return markUnknownExternal({
			routeId: params.routeId,
			runId: params.runId,
			error: `Provider rejection could not be durably settled: ${errorText(error)}`,
			reason: "provider_rejection_settlement_failed",
		});
	}
	if (settled || (await AbuseRepository.getRoute(params.routeId))?.status === "provider_rejected") {
		return { outcome: "provider_rejected", runId: params.runId, reason: params.reason };
	}
	return markUnknownExternal({
		routeId: params.routeId,
		runId: params.runId,
		error: "A provider rejection was received after this route could no longer be settled.",
		reason: "provider_rejection_settlement_conflict",
	});
}

async function settleInsufficientEvidence(routeId: bigint, reason: string): Promise<ProviderSubmissionExecutionResult> {
	const changed = await AbuseRepository.transitionRouteStatus({
		routeId,
		from: ["queued", "verified"],
		to: "insufficient_evidence",
		data: { reason },
	});
	if (changed || (await AbuseRepository.getRoute(routeId))?.status === "insufficient_evidence") {
		return { outcome: "insufficient_evidence", reason };
	}
	return { outcome: "not_eligible" };
}

/**
 * Execute a direct provider complaint behind one durable, no-replay boundary.
 *
 * A provider prepares an immutable payload while the route is still queued or
 * verified. The durable run is then created before any ephemeral provider
 * preflight work (for example, obtaining a short-lived CAPTCHA token). Only
 * after that preflight succeeds does this helper write `submission_started`
 * and invoke the irreversible provider-owned `submit` implementation. Any
 * unexpected result after that marker is treated as ambiguous and is never
 * retried automatically.
 */
export async function executeProviderSubmission(params: {
	routeId: bigint;
	provider: ProviderSubmissionProvider;
}): Promise<ProviderSubmissionExecutionResult> {
	const route = await AbuseRepository.getRoute(params.routeId);
	if (!route || route.routeType !== "provider_submission" || route.providerRegistryKey !== params.provider.definition.key) {
		return { outcome: "not_eligible" };
	}

	// A route pins the reviewed provider implementation. Never execute a new
	// provider definition against a route created under a different one.
	if (!providerDefinitionMatchesPin(
		params.provider.definition,
		route.providerDefinitionVersion,
		route.providerDefinitionHash,
	)) {
		await AbuseRepository.transitionRouteStatus({
			routeId: route.id,
			from: ["queued", "verified", "running"],
			to: "needs_human",
			data: { reason: "provider_definition_pin_mismatch" },
		});
		return { outcome: "not_eligible" };
	}

	let preparedPayload: Record<string, unknown> = {};
	if (route.status === "queued" || route.status === "verified") {
		if (params.provider.prepareSubmission) {
			let preparation: ProviderSubmissionPreparation;
			try {
				preparation = await params.provider.prepareSubmission({ routeId: route.id, payload: {} });
			} catch (error) {
				if (error instanceof ProviderSubmissionRejectedError) {
					return settleKnownRejection({ routeId: route.id, reason: errorText(error) });
				}
				// Nothing irreversible has happened, so ordinary preparation errors
				// remain retryable by the durable job.
				throw error;
			}
			if (!isPreparation(preparation)) {
				await AbuseRepository.transitionRouteStatus({
					routeId: route.id,
					from: ["queued", "verified"],
					to: "needs_human",
					data: { reason: "provider_submission_preparation_invalid" },
				});
				return { outcome: "not_eligible" };
			}
			if (preparation.outcome === "insufficient_evidence") {
				return settleInsufficientEvidence(route.id, preparation.reason);
			}
			preparedPayload = preparation.payload;
		}
	} else if (route.status !== "running") {
		return { outcome: "not_eligible" };
	}

	const execution = await AbuseRepository.beginProviderExecution({
		routeId: route.id,
		providerPayload: preparedPayload,
		correlationKey: correlationKey(params.provider, route.id),
		expectedStatus: route.status === "queued" ? "queued" : "verified",
	});
	if (!execution) return { outcome: "not_eligible" };

	const run = execution.run;
	let durablePayload = run.providerPayload;
	if (execution.resumed
		&& run.executionStatus === "starting"
		&& params.provider.prepareSubmission
		&& params.provider.shouldRefreshStartingPayload?.({ routeId: route.id, runId: run.id, payload: isRecord(durablePayload) ? durablePayload : {} })) {
		// A route can be left in `running/starting` when a previous worker dies
		// during preflight. No provider request has crossed the durable marker in
		// this state, so refresh an older draft before retrying. This is what
		// lets deployments replace legacy analysis-only drafts without ever
		// mutating a request that may already have reached a provider.
		let refreshed: ProviderSubmissionPreparation;
		try {
			refreshed = await params.provider.prepareSubmission({ routeId: route.id, runId: run.id, payload: isRecord(durablePayload) ? durablePayload : {} });
		} catch (error) {
			if (error instanceof ProviderSubmissionRejectedError) {
				return settleKnownRejection({ routeId: route.id, runId: run.id, reason: errorText(error) });
			}
			throw error;
		}
		if (!isPreparation(refreshed)) {
			await AbuseRepository.settleProviderRun({
				runId: run.id,
				executionStatus: "failed",
				routeStatus: "needs_human",
				failureReason: "provider_submission_preparation_invalid",
				routeData: { reason: "provider_submission_preparation_invalid" },
			});
			return { outcome: "not_eligible" };
		}
		if (refreshed.outcome === "insufficient_evidence") {
			const settled = await AbuseRepository.settleProviderRun({
				runId: run.id,
				executionStatus: "failed",
				routeStatus: "insufficient_evidence",
				failureReason: refreshed.reason,
				routeData: { reason: refreshed.reason },
			});
			if (settled || (await AbuseRepository.getRoute(route.id))?.status === "insufficient_evidence") {
				return { outcome: "insufficient_evidence", reason: refreshed.reason };
			}
			return markUnknownExternal({
				routeId: route.id,
				runId: run.id,
				error: "Provider draft refresh found insufficient evidence after the route left its expected state.",
				reason: "provider_submission_refresh_state_conflict",
			});
		}

		durablePayload = refreshed.payload;
		if (!isRecord(run.providerPayload) || hashStableJson(run.providerPayload) !== hashStableJson(durablePayload)) {
			await AbuseRepository.updateProviderRun(
				run.id,
				{ providerPayload: durablePayload, payloadHash: hashStableJson(durablePayload) },
				"provider_run.draft_refreshed",
			);
		}
	}
	if (!isRecord(durablePayload)) {
		return markUnknownExternal({
			routeId: route.id,
			runId: run.id,
			error: "The persisted provider-submission payload is malformed; automatic submission is blocked.",
			reason: "provider_submission_payload_invalid",
		});
	}
	if (run.executionStatus === "submission_started") {
		return markUnknownExternal({
			routeId: route.id,
			runId: run.id,
			error: "Provider submission was interrupted after its durable pre-call marker; it will not be replayed automatically.",
			reason: "provider_submission_interrupted",
		});
	}
	if (run.executionStatus !== "starting") {
		return markUnknownExternal({
			routeId: route.id,
			runId: run.id,
			error: `Provider-submission run is not eligible from ${run.executionStatus}.`,
			reason: "provider_submission_run_state_invalid",
		});
	}

	const context: ProviderSubmissionContext = { routeId: route.id, runId: run.id, payload: durablePayload };
	let preflight: ProviderSubmissionPreflight | undefined;
	if (params.provider.prepareExternalSubmission) {
		// This hook is deliberately before the durable provider-call marker. A
		// solver/browser failure cannot have filed the complaint, so the worker
		// may retry the same durable run instead of incorrectly fencing it as an
		// ambiguous provider submission. Providers must clean up partially-created
		// ephemeral state if their hook itself rejects.
		preflight = await params.provider.prepareExternalSubmission(context);
	}
	if (preflight && !params.provider.submitPrepared) {
		await disposePreflight(preflight);
		throw new Error(`Provider ${params.provider.definition.key} returned preflight state without a prepared submit handler.`);
	}

	let markerAcquired: boolean;
	try {
		markerAcquired = await AbuseRepository.prepareProviderSubmission(run.id);
	} catch (error) {
		await disposePreflight(preflight);
		throw error;
	}
	if (!markerAcquired) {
		await disposePreflight(preflight);
		return markUnknownExternal({
			routeId: route.id,
			runId: run.id,
			error: "Provider submission could not acquire its durable pre-call marker.",
			reason: "provider_submission_marker_conflict",
		});
	}

	let success: ProviderSubmissionSuccess;
	try {
		success = preflight
			? await params.provider.submitPrepared!(context, preflight)
			: await params.provider.submit(context);
	} catch (error) {
		await disposePreflight(preflight);
		if (error instanceof ProviderSubmissionRejectedError) {
			return settleKnownRejection({ routeId: route.id, runId: run.id, reason: errorText(error) });
		}
		return markUnknownExternal({
			routeId: route.id,
			runId: run.id,
			error: errorText(error),
			reason: "provider_submission_ambiguous",
		});
	}
	await disposePreflight(preflight);
	if (!isSubmissionSuccess(success)) {
		return markUnknownExternal({
			routeId: route.id,
			runId: run.id,
			error: "Provider submission returned an invalid confirmed-success payload.",
			reason: "provider_submission_success_invalid",
		});
	}

	let settled: boolean;
	try {
		settled = await AbuseRepository.settleProviderRun({
			runId: run.id,
			executionStatus: "completed",
			routeStatus: "submitted",
			confirmationId: success.confirmationId,
			confirmationText: success.confirmationText,
			finalUrl: success.finalUrl,
			submittedTargets: success.submittedTargets,
		});
	} catch (error) {
		return markUnknownExternal({
			routeId: route.id,
			runId: run.id,
			error: `Provider submission completed but its durable settlement failed: ${errorText(error)}`,
			reason: "provider_submission_settlement_failed",
		});
	}
	if (settled || (await AbuseRepository.getRoute(route.id))?.status === "submitted") {
		return { outcome: "submitted", runId: run.id };
	}
	return markUnknownExternal({
		routeId: route.id,
		runId: run.id,
		error: "Provider submission completed but its durable settlement could not be recorded.",
		reason: "provider_submission_settlement_conflict",
	});
}
