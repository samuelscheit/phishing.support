import {
	CORRESPONDENCE_POLL_INTERVAL_MS,
	CORRESPONDENCE_POLL_WINDOW_MS,
	getProviderSubmissionProvider,
	listProviderSubmissionProviders,
	queueCorrespondencePoll,
} from "../providers";
import { AbuseRepository } from "../repository";

/**
 * Read a submitted report's correspondence from its provider's API, record
 * new messages and any review-status change on the route, and schedule the
 * next read until the polling window after submission has passed.
 */
export async function pollProviderCorrespondence(params: { routeId: bigint; jobId: bigint; signal?: AbortSignal }): Promise<void> {
	const { routeId, signal } = params;
	const route = await AbuseRepository.getRoute(routeId);
	if (!route || route.status !== "submitted") return;
	const provider = getProviderSubmissionProvider(route.providerRegistryKey);
	const run = await AbuseRepository.getLatestProviderRunForRoute(route.id);
	if (!provider?.fetchCorrespondence || !run?.confirmationId) return;

	const correspondence = await provider.fetchCorrespondence({ confirmationId: run.confirmationId, ...(signal ? { signal } : {}) });
	await AbuseRepository.recordProviderCorrespondence({
		route,
		messages: [
			...correspondence.messages.map((message) => ({ ...message, from: provider.definition.displayName })),
			...(correspondence.status
				? [{
					// One record per distinct review state keeps the status history.
					id: `status:${correspondence.status.state}`,
					subject: `Report status: ${correspondence.status.state}`,
					body: correspondence.status.detail ?? "",
					sentAt: new Date(),
					from: provider.definition.displayName,
				}]
				: []),
		],
	});

	const elapsed = Date.now() - run.createdAt.getTime();
	if (elapsed < CORRESPONDENCE_POLL_WINDOW_MS) await queueCorrespondencePoll(route, { delayMs: CORRESPONDENCE_POLL_INTERVAL_MS, successorOf: params.jobId });
}

/**
 * Queue a correspondence poll for every submitted report still inside its
 * polling window, so reports filed before a restart (or before polling
 * existed) are read too. One pending poll per route makes this idempotent.
 */
export async function ensureCorrespondencePolls(): Promise<void> {
	const keys = listProviderSubmissionProviders().filter((provider) => provider.fetchCorrespondence).map((provider) => provider.definition.key);
	const cutoff = Date.now() - CORRESPONDENCE_POLL_WINDOW_MS;
	for (const { route, submittedAt } of await AbuseRepository.listSubmittedRoutesWithReceipt(keys)) {
		if (submittedAt.getTime() >= cutoff) await queueCorrespondencePoll(route);
	}
}
