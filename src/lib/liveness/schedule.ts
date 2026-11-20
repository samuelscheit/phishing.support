import { AbuseRepository } from "../abuse/repository";
import type { AbuseJob } from "../abuse/schema";
import { DAY_MS, HOUR_MS } from "../util/date_time";
import { checkSite, type SiteCheckDependencies } from "./check";
import { listLivenessTargets, livenessJobKey, recordSiteCheck, type LivenessTarget } from "./repository";

/**
 * When a reported site is checked, after its report. Dense at first, when
 * most takedowns happen and their time is worth knowing to the hour, then
 * sparse until a month shows whether the site stayed down.
 */
export const LIVENESS_CHECK_OFFSETS_MS = [HOUR_MS, 6 * HOUR_MS, DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS] as const;

/**
 * When the target's next check is due, or undefined once its schedule is
 * done: the first offset no check has covered yet. Offsets that passed
 * unchecked (the worker was down, the target predates the checks) collapse
 * into one check now, so a target reported over a month ago and never
 * checked gets exactly one.
 */
export function nextLivenessCheckAt(reportedAt: Date, lastCheckedAt: Date | undefined, now: Date): Date | undefined {
	const due = LIVENESS_CHECK_OFFSETS_MS
		.map((offset) => reportedAt.getTime() + offset)
		.find((at) => lastCheckedAt === undefined || at > lastCheckedAt.getTime());
	return due === undefined ? undefined : new Date(Math.max(due, now.getTime()));
}

/** Queue the target's next check, or nothing once its schedule is done. A running check passes itself as `successorOf`. */
async function queueLivenessCheck(target: LivenessTarget, options: { successorOf?: bigint; now?: Date } = {}): Promise<AbuseJob | undefined> {
	const at = nextLivenessCheckAt(target.reportedAt, target.lastCheckedAt, options.now ?? new Date());
	if (!at) return undefined;
	return AbuseRepository.enqueueJob({
		jobType: "check_site_liveness",
		reportId: target.reportId,
		payload: { targetId: target.targetId.toString() },
		dedupeKey: livenessJobKey(target.targetId),
		nextAttemptAt: at,
		...(options.successorOf === undefined ? {} : { successorOf: options.successorOf }),
	});
}

/** Start a target's checks once it is resolved; a target that is no site to visit gets none. */
export async function scheduleLivenessChecks(targetId: bigint): Promise<void> {
	const [target] = await listLivenessTargets({ targetId });
	if (target) await queueLivenessCheck(target);
}

/**
 * Queue the next check of every target whose schedule is not done and that
 * has none pending, so a target whose chain broke on a failed job is checked
 * again. Idempotent.
 */
export async function ensureLivenessChecks(): Promise<void> {
	const now = new Date();
	for (const target of await listLivenessTargets({ withoutPendingCheck: true })) await queueLivenessCheck(target, { now });
}

/** Check the target's site, record what the check found, and queue the next check on its schedule. */
export async function runLivenessCheck(params: { jobId: bigint; targetId: bigint; dependencies?: SiteCheckDependencies }): Promise<void> {
	const [target] = await listLivenessTargets({ targetId: params.targetId });
	// Deleted, canceled, or no longer a site to visit: its checks end here.
	if (!target) return;
	const result = await checkSite(target.url, params.dependencies);
	await recordSiteCheck(target, result);
	await queueLivenessCheck({ ...target, lastCheckedAt: result.checkedAt }, { successorOf: params.jobId, now: result.checkedAt });
}
