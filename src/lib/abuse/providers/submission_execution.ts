import { AbuseRepository } from "../repository";

import { providerDefinitionMatchesPin } from "./kit/pin";
import { fallBackToEmail } from "./email_fallback";

import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionProvider,
	type ProviderSubmissionSuccess,
} from "./submission_contracts";
import { throwIfAborted } from "../worker/shared";
import { nextCorrespondencePollDelayMs, nextReceiptLookupDelayMs, queueCorrespondencePoll, queueReceiptLookup } from "../worker/schedule";
import { boundedErrorText } from "../../util/error_text";
import { isRecord } from "../../util/values";
import { hashStableJson } from "../../util/hash";

export type ProviderSubmissionExecutionResult =
	| { outcome: "submitted"; runId: bigint }
	| { outcome: "provider_rejected"; runId?: bigint; reason: string }
	| { outcome: "needs_human"; runId?: bigint; reason: string }
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

type KnownFailureStatus = "provider_rejected" | "needs_human" | "insufficient_evidence";

/**
 * Settle an explicit, known provider failure as a terminal route status: the
 * run's too once there is one, else only the route, which is still queued or verified.
 */
async function settleKnownFailure(params: {
	routeId: bigint;
	runId?: bigint;
	status: KnownFailureStatus;
	reason: string;
}): Promise<ProviderSubmissionExecutionResult> {
	const { status } = params;
	const result: ProviderSubmissionExecutionResult = status === "insufficient_evidence" || params.runId === undefined
		? { outcome: status, reason: params.reason }
		: { outcome: status, runId: params.runId, reason: params.reason };
	if (params.runId === undefined) {
		const changed = await AbuseRepository.transitionRouteStatus({
			routeId: params.routeId,
			from: ["queued", "verified"],
			to: status,
			data: { reason: params.reason },
		});
		return changed || (await AbuseRepository.getRoute(params.routeId))?.status === status ? result : { outcome: "not_eligible" };
	}

	let settled: boolean;
	try {
		settled = await AbuseRepository.settleProviderRun({
			runId: params.runId,
			executionStatus: "failed",
			routeStatus: status,
			failureReason: params.reason,
			routeData: { reason: params.reason },
		});
	} catch (error) {
		return markUnknownExternal({
			routeId: params.routeId,
			runId: params.runId,
			error: `Provider ${status} could not be durably settled: ${boundedErrorText(error)}`,
			reason: `${status}_settlement_failed`,
		});
	}
	if (settled || (await AbuseRepository.getRoute(params.routeId))?.status === status) return result;
	return markUnknownExternal({
		routeId: params.routeId,
		runId: params.runId,
		error: `A provider ${status} result was received after this route could no longer be settled.`,
		reason: `${status}_settlement_conflict`,
	});
}

/** Map a provider's explicit known-failure error to its terminal settlement, if it is one. */
function knownFailureStatus(error: unknown): "provider_rejected" | "needs_human" | undefined {
	if (error instanceof ProviderSubmissionRejectedError) return "provider_rejected";
	if (error instanceof ProviderSubmissionNeedsHumanError) return "needs_human";
	return undefined;
}

/**
 * Build the draft from the current route and report, before any marker: the
 * first attempt's (no run yet) and a run's that never reached its marker.
 * Whatever the provider refuses, or returns malformed, settles for good with
 * its reason; any other error is retryable, nothing irreversible happened.
 */
async function prepareDraft(
	provider: ProviderSubmissionProvider,
	context: ProviderSubmissionContext,
): Promise<{ payload: Record<string, unknown> } | ProviderSubmissionExecutionResult> {
	const settle = (status: KnownFailureStatus, reason: string) => settleKnownFailure({ routeId: context.routeId, ...(context.runId === undefined ? {} : { runId: context.runId }), status, reason });
	let preparation: ProviderSubmissionPreparation;
	try {
		preparation = await provider.prepareSubmission(context);
		throwIfAborted(context.signal);
	} catch (error) {
		const status = knownFailureStatus(error);
		if (status) return settle(status, boundedErrorText(error));
		throw error;
	}
	if (!isPreparation(preparation)) return settle("needs_human", "provider_submission_preparation_invalid");
	return preparation.outcome === "insufficient_evidence" ? settle("insufficient_evidence", preparation.reason) : { payload: preparation.payload };
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
	/** Ephemeral job deadline; never persisted. */
	signal?: AbortSignal;
}): Promise<ProviderSubmissionExecutionResult> {
	const result = await executeOnce(params);
	await fallBackToEmail(params.provider, params.routeId, result.outcome);
	return result;
}

async function executeOnce(params: Parameters<typeof executeProviderSubmission>[0]): Promise<ProviderSubmissionExecutionResult> {
	throwIfAborted(params.signal);
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
		const prepared = await prepareDraft(params.provider, { routeId: route.id, payload: {}, ...(params.signal ? { signal: params.signal } : {}) });
		if (!("payload" in prepared)) return prepared;
		preparedPayload = prepared.payload;
	} else if (route.status !== "running") {
		return { outcome: "not_eligible" };
	}
	throwIfAborted(params.signal);

	const execution = await AbuseRepository.beginProviderExecution({
		routeId: route.id,
		providerPayload: preparedPayload,
		correlationKey: correlationKey(params.provider, route.id),
		expectedStatus: route.status === "queued" ? "queued" : "verified",
	});
	if (!execution) return { outcome: "not_eligible" };
	throwIfAborted(params.signal);

	const run = execution.run;
	const durablePayload = run.providerPayload;
	throwIfAborted(params.signal);
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

	let context: ProviderSubmissionContext = {
		routeId: route.id,
		runId: run.id,
		payload: durablePayload,
		...(params.signal ? { signal: params.signal } : {}),
	};
	// Only work that cannot file anything runs before the marker, and this is
	// the check that the stored draft is still what the provider builds. A run
	// that never passed the marker may have been interrupted before its report
	// or narrative changed: build the draft again and replace it. A run that
	// passed the marker never gets here.
	let verified: unknown;
	try {
		verified = await params.provider.verifyDraft(context);
	} catch (error) {
		const refreshed = await prepareDraft(params.provider, context);
		if (!("payload" in refreshed)) return refreshed;
		if (hashStableJson(durablePayload) !== hashStableJson(refreshed.payload) && !(await AbuseRepository.replaceStartingDraft(run.id, refreshed.payload))) {
			throw error;
		}
		context = { ...context, payload: refreshed.payload };
		verified = await params.provider.verifyDraft(context);
	}
	throwIfAborted(params.signal);

	const { provider } = params;
	let preflight: ProviderSubmissionPreflight | undefined;
	let file: () => Promise<ProviderSubmissionSuccess>;
	if ("prepareExternalSubmission" in provider) {
		// Before the durable provider-call marker: a solver/browser failure
		// cannot have filed the complaint, so the worker may retry the same
		// durable run instead of fencing it as an ambiguous submission.
		// Providers clean up the partial ephemeral state if their hook rejects.
		let prepared: ProviderSubmissionPreflight;
		try {
			prepared = await provider.prepareExternalSubmission(context, verified);
		} catch (error) {
			// An explicit auth/session failure happens before the marker, so no
			// complaint was filed; settle it for a person instead of retrying.
			if (error instanceof ProviderSubmissionNeedsHumanError) {
				return settleKnownFailure({ routeId: route.id, runId: run.id, status: "needs_human", reason: boundedErrorText(error) });
			}
			throw error;
		}
		preflight = prepared;
		file = () => provider.submitPrepared(context, prepared);
	} else {
		file = () => provider.submit(context);
	}

	let markerAcquired: boolean;
	try {
		// Once prepared, any failure or abort before the marker releases the preflight's browser/lease.
		throwIfAborted(params.signal);
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
		success = await file();
	} catch (error) {
		await disposePreflight(preflight);
		const status = knownFailureStatus(error);
		if (status) return settleKnownFailure({ routeId: route.id, runId: run.id, status, reason: boundedErrorText(error) });
		await AbuseRepository.markUnknownExternalState({ routeId: route.id, runId: run.id, error: boundedErrorText(error), reason: "provider_submission_ambiguous" });
		// The provider may have filed it anyway; its own records settle that later.
		if (params.provider.findSubmission) {
			await queueReceiptLookup(route, run.id, { delayMs: nextReceiptLookupDelayMs(0)! })
				.catch((queueError: unknown) => console.warn(`Queueing the receipt lookup for route ${route.id.toString()} failed:`, queueError));
		}
		throw new ProviderSubmissionUnknownExternalStateError(boundedErrorText(error));
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
			error: `Provider submission completed but its durable settlement failed: ${boundedErrorText(error)}`,
			reason: "provider_submission_settlement_failed",
		});
	}
	if (settled || (await AbuseRepository.getRoute(route.id))?.status === "submitted") {
		if (params.provider.fetchCorrespondence && success.confirmationId) await queueCorrespondencePoll(route, { delayMs: nextCorrespondencePollDelayMs(0) });
		return { outcome: "submitted", runId: run.id };
	}
	return markUnknownExternal({
		routeId: route.id,
		runId: run.id,
		error: "Provider submission completed but its durable settlement could not be recorded.",
		reason: "provider_submission_settlement_conflict",
	});
}
