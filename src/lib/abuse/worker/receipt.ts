import {
	getProviderSubmissionProvider,
	listProviderSubmissionProviders,
} from "../providers";
import { nextReceiptLookupDelayMs, queueCorrespondencePoll, queueReceiptLookup } from "./schedule";
import { AbuseRepository } from "../repository";

/**
 * Look for the report an ambiguous submission filed at its provider. A match
 * settles the run as submitted with the provider's receipt, and its
 * correspondence is read from then on; no match queues the next lookup until
 * the schedule is over. Nothing is ever submitted again.
 */
export async function findProviderReceipt(params: {
	runId: bigint;
	jobId: bigint;
	signal?: AbortSignal;
	providerFor?: typeof getProviderSubmissionProvider;
}): Promise<void> {
	const run = await AbuseRepository.getProviderRun(params.runId);
	const route = run ? await AbuseRepository.getRoute(run.routeId) : undefined;
	if (!run || !route || run.executionStatus !== "unknown_external_state" || route.status !== "unknown_external_state") return;
	const provider = (params.providerFor ?? getProviderSubmissionProvider)(route.providerRegistryKey);
	const payload = run.providerPayload;
	if (!provider?.findSubmission || !payload || typeof payload !== "object" || Array.isArray(payload)) return;

	const receipt = await provider.findSubmission({
		routeId: route.id,
		runId: run.id,
		payload: payload as Record<string, unknown>,
		// The run exists before its request; the lookup only widens by that much.
		sentAt: run.createdAt,
		...(params.signal ? { signal: params.signal } : {}),
	});
	if (receipt?.confirmationId && receipt.submittedTargets.length) {
		const reconciled = await AbuseRepository.reconcileProviderRun({
			runId: run.id,
			providerRegistryKey: provider.definition.key,
			confirmationId: receipt.confirmationId,
			...(receipt.confirmationText ? { confirmationText: receipt.confirmationText } : {}),
			...(receipt.finalUrl ? { finalUrl: receipt.finalUrl } : {}),
			submittedTargets: receipt.submittedTargets,
			reconciliationReason: "provider_receipt_found",
		});
		if (reconciled && provider.fetchCorrespondence) await queueCorrespondencePoll(route);
		return;
	}
	const delayMs = nextReceiptLookupDelayMs(Date.now() - run.createdAt.getTime());
	if (delayMs !== undefined) await queueReceiptLookup(route, run.id, { delayMs, successorOf: params.jobId });
}

/** At startup, look once more for every ambiguous run still within the lookup schedule. */
export async function ensureReceiptLookups(): Promise<void> {
	const keys = listProviderSubmissionProviders().filter((provider) => provider.findSubmission).map((provider) => provider.definition.key);
	for (const { route, run } of await AbuseRepository.listUnresolvedProviderRuns(keys)) {
		if (nextReceiptLookupDelayMs(Date.now() - run.createdAt.getTime()) !== undefined) await queueReceiptLookup(route, run.id, { delayMs: 0 });
	}
}
