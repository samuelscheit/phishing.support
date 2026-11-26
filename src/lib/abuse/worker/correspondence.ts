import { getProviderSubmissionProvider, listProviderSubmissionProviders } from "../providers";
import { CORRESPONDENCE_POLL_WINDOW_MS, nextCorrespondencePollDelayMs, queueCorrespondencePoll } from "./schedule";
import { AbuseRepository } from "../repository";
import { enqueueOriginHostDisclosures } from "../origin/disclosure";
import { recheckAfterProviderAction } from "./provider_action";

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
	const status = correspondence.status;
	const verdict = status && provider.reviewVerdicts?.[status.state];
	// Every change of review state is one record, a return to an earlier state too:
	// the latest record is the verdict in effect.
	const records = (await AbuseRepository.listMailForReport(route.reportId))
		.filter((message) => message.routeId === route.id && message.correlationKey?.startsWith(`provider-api:${route.providerRegistryKey}:status:`))
		.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
	const subject = status && `Report status: ${status.state}`;
	const changed = status && records.at(-1)?.subject !== subject;
	const stored = await AbuseRepository.recordProviderCorrespondence({
		route,
		messages: [
			...correspondence.messages.map((message) => ({ ...message, from: provider.definition.displayName })),
			...(status && changed
				? [{
					// The id is unique per provider, so it names the route; a state seen before also names when it returned.
					id: `status:${route.id.toString()}:${status.state}${records.some((record) => record.subject === subject) ? `:${Date.now()}` : ""}`,
					subject: subject!,
					body: status.detail ?? "",
					sentAt: new Date(),
					from: provider.definition.displayName,
					...(verdict ? { classification: verdict } : {}),
				}]
				: []),
		],
	});
	const storedMessages = (await Promise.all(stored.map(({ id }) => AbuseRepository.getMailMessage(id))))
		.filter((message) => message !== undefined);
	await enqueueOriginHostDisclosures(route, storedMessages);
	await recheckAfterProviderAction(route, storedMessages);
	const state = correspondence.status?.state;
	if (state && provider.decisionFollowUp?.contestedStates.includes(state)) {
		// Once per route and decision, for the lifetime of the case.
		await AbuseRepository.enqueueJobOnce({
			jobType: "follow_up_provider_decision",
			reportId: route.reportId,
			routeId: route.id,
			payload: { state, ...(correspondence.status?.detail ? { detail: correspondence.status.detail } : {}) },
			dedupeKey: `decision-follow-up:${route.id.toString()}:${state}`,
		});
	}

	const elapsed = Date.now() - run.createdAt.getTime();
	if (!correspondence.final && elapsed < CORRESPONDENCE_POLL_WINDOW_MS) await queueCorrespondencePoll(route, { delayMs: nextCorrespondencePollDelayMs(elapsed), successorOf: params.jobId });
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
