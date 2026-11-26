import { AbuseRepository } from "../abuse/repository";
import type { AbuseJob } from "../abuse/schema";
import { DAY_MS, HOUR_MS } from "../util/date_time";
import { checkSite, type SiteCheckDependencies } from "./check";
import { attributeCheck, observeHostMove, type HostMoveDependencies } from "./host_move";
import { listLivenessTargets, listSiteChecksForTargets, livenessJobKey, recordSiteCheck, type LivenessTarget } from "./repository";

/**
 * When a reported site is checked, after its report. Dense at first, when
 * most takedowns happen and their time is worth knowing to the hour, then
 * sparse until a month shows whether the site stayed down.
 */
export const LIVENESS_CHECK_OFFSETS_MS = [HOUR_MS, 6 * HOUR_MS, DAY_MS, 3 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS, 30 * DAY_MS] as const;

/**
 * How soon after a provider acts on a site, or the site moves, it is checked
 * again: an operator answers a CDN's block by leaving the CDN within hours
 * (trylevo.app, case 384401854580134038), and the next check on the report's
 * schedule may be days away.
 */
export const LIVENESS_RECHECK_AFTER_CHANGE_MS = HOUR_MS;

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

/**
 * Queue the target's next check, or nothing once its schedule is done. A
 * running check passes itself as `successorOf`; `by` brings the check
 * forward to then, also after the schedule is done.
 */
async function queueLivenessCheck(target: LivenessTarget, options: { successorOf?: bigint; now?: Date; by?: Date } = {}): Promise<AbuseJob | undefined> {
	const scheduled = nextLivenessCheckAt(target.reportedAt, target.lastCheckedAt, options.now ?? new Date());
	const at = scheduled && options.by ? new Date(Math.min(scheduled.getTime(), options.by.getTime())) : scheduled ?? options.by;
	if (!at) return undefined;
	return AbuseRepository.enqueueJob({
		jobType: "check_site_liveness",
		reportId: target.reportId,
		payload: { targetId: target.targetId.toString() },
		dedupeKey: livenessJobKey(target.targetId),
		nextAttemptAt: at,
		advance: true,
		...(options.successorOf === undefined ? {} : { successorOf: options.successorOf }),
	});
}

/** Start a target's checks once it is resolved; a target that is no site to visit gets none. */
export async function scheduleLivenessChecks(targetId: bigint): Promise<void> {
	const [target] = await listLivenessTargets({ targetId });
	if (target) await queueLivenessCheck(target);
}

/**
 * Check the target's site within an hour of `changedAt`, when a provider
 * acted on it: its pending check is brought forward, or one is queued after
 * its schedule ended. The check after that returns to the schedule.
 */
export async function checkSoonAfter(targetId: bigint, changedAt: Date): Promise<void> {
	const [target] = await listLivenessTargets({ targetId });
	if (!target) return;
	const by = new Date(changedAt.getTime() + LIVENESS_RECHECK_AFTER_CHANGE_MS);
	// A check already made after the change and its hour has seen what the change did.
	if (target.lastCheckedAt && target.lastCheckedAt >= by) return;
	await queueLivenessCheck(target, { by: new Date(Math.max(by.getTime(), Date.now())) });
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

/**
 * Check the target's site, attribute the addresses it resolved to their
 * networks, record whether it moved since the last check (or since it was
 * reported), record what the check found, and queue the next check on its
 * schedule: within the hour after a move, unless this check was itself the
 * recheck of one (a site flapping between hosts gets no hourly chain).
 */
export async function runLivenessCheck(params: { jobId: bigint; targetId: bigint; dependencies?: SiteCheckDependencies & HostMoveDependencies }): Promise<void> {
	const [target] = await listLivenessTargets({ targetId: params.targetId });
	// Deleted, canceled, or no longer a site to visit: its checks end here.
	if (!target) return;
	const dependencies = params.dependencies ?? {};
	const checks = await listSiteChecksForTargets([target.targetId]);
	const result = await attributeCheck(await checkSite(target.url, dependencies), checks.at(-1), dependencies);
	const { move, recheck } = await observeHostMove({ target, result, checks, jobId: params.jobId }, dependencies);
	await recordSiteCheck(target, result);
	await queueLivenessCheck({ ...target, lastCheckedAt: result.checkedAt }, {
		successorOf: params.jobId,
		now: result.checkedAt,
		...(move && !recheck ? { by: new Date(result.checkedAt.getTime() + LIVENESS_RECHECK_AFTER_CHANGE_MS) } : {}),
	});
}
