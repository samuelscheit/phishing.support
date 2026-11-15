import { AbuseRepository } from "../repository";
import type { AbuseTargetResolver } from "./shared";
import type { ResolvedAbuseTarget } from "../resolver";

/** Retries a resolution whose lookups failed gets before its routes are kept as they are. */
export const RESOLUTION_LOOKUP_RETRIES = 5;
const LOOKUP_RETRY_AFTER_MS = 60_000;

/**
 * A lookup failed (rate limit, timeout, server error), so a route it would
 * have found, such as the hosting provider's abuse mailbox, may be missing.
 * Nothing is saved: the job runs again after `retryAfterMs`.
 */
export class IncompleteResolutionError extends Error {
	readonly retryAfterMs = LOOKUP_RETRY_AFTER_MS;
	constructor(readonly lookupFailures: string[]) {
		super(`Abuse contact lookups failed and will be repeated: ${lookupFailures.join("; ")}`);
		this.name = "IncompleteResolutionError";
	}
}

/**
 * Resolve every target, then save their routes and queue their delivery.
 * While retries remain (`retryCount` below `RESOLUTION_LOOKUP_RETRIES`), a
 * failed lookup repeats the whole resolution instead of saving the routes
 * found so far; afterwards they are saved as they are.
 */
export async function resolveReport(reportId: bigint, resolveTarget: AbuseTargetResolver, retryCount = RESOLUTION_LOOKUP_RETRIES): Promise<void> {
	const input = await AbuseRepository.getReportInput(reportId);
	if (!input) throw new Error("Abuse report no longer exists.");
	// A resolver job can be replayed after a lease expiry. Once another
	// worker has moved the report into verification/execution or a terminal
	// aggregate, this old job must not reopen it or enqueue duplicate work.
	if (!["accepted", "resolving"].includes(input.report.status)) return;
	if (input.report.status === "accepted") {
		await AbuseRepository.transitionReportStatus({ reportId, from: "accepted", to: "resolving" });
	}
	const resolutions = await Promise.all(input.targets.map(async (target) => ({
		target,
		resolved: await resolveTarget({
			normalizedTarget: target.normalizedTarget,
			targetType: target.targetType,
			observedUrls: target.observedUrls,
		}),
	})));
	const lookupFailures = resolutions.flatMap(({ resolved }) => resolved.lookupFailures ?? []);
	if (lookupFailures.length > 0 && retryCount < RESOLUTION_LOOKUP_RETRIES) throw new IncompleteResolutionError(lookupFailures);
	for (const { target, resolved } of resolutions) await saveResolvedTarget(reportId, target.id, resolved);
	await AbuseRepository.recomputeReportStatus(reportId);
}

/**
 * Save one target's resolution and queue delivery on each verified route.
 * A route that already exists past `resolving` is left as it is, and jobs are
 * deduplicated, so saving a later resolution only adds the routes it newly found.
 */
export async function saveResolvedTarget(reportId: bigint, targetId: bigint, resolved: ResolvedAbuseTarget): Promise<void> {
	await AbuseRepository.setTargetResolution({
		targetId,
		status: resolved.status,
		resolverSnapshot: resolved.resolverSnapshot,
		disposition: resolved.disposition,
	});
	for (const routeInput of resolved.routes) {
		const route = await AbuseRepository.upsertResolvedRoute(targetId, routeInput);
		if (route.status !== "verified") continue;
		if (route.routeType === "provider_submission") {
			await AbuseRepository.enqueueJob({ jobType: "submit_provider", reportId, routeId: route.id, payload: {}, dedupeKey: `provider-submit:${route.id.toString()}` });
		} else if (route.routeType === "email") {
			await AbuseRepository.enqueueJob({ jobType: "send_email", reportId, routeId: route.id, payload: {}, dedupeKey: `email:${route.id.toString()}` });
		}
	}
}
