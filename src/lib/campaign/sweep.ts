import { AbuseRepository } from "../abuse/repository";
import { isUrlscanBusy, urlscanRetryAfterMs } from "../abuse/origin/urlscan";
import { SubmissionsEntity } from "../db/entities/submissions";
import { errorSummary } from "../util/error_text";
import { backfillKitResources, type KitBackfillDependencies } from "./kit_backfill";
import { armCampaignKitSearch } from "./kit_search";
import { linkSiteMember, type LinkDependencies } from "./link";
import { headlineSite, type CampaignMember } from "./members";
import { linkJob } from "./queue";
import { CampaignRepository } from "./repository";

/**
 * Bump when what a site's indicators are, or where they come from, changes:
 * on the next start every confirmed site is linked again, once.
 */
export const CAMPAIGN_RULES_VERSION = 9;
/** Sites of a sweep are linked this far apart: each may ask urlscan for its kit files. */
const SWEEP_SPACING_MS = 20_000;
/** Sites of one campaign arrive in bursts: it is described once the burst settles. */
const DESCRIBE_AFTER_MS = 5 * 60_000;

/**
 * Queue the link job of every site every reported case confirmed (its own
 * reports and those it joined), once per `label`; returns how many members
 * the sweep covers.
 */
export async function enqueueCampaignSweep(label: string, now = new Date()): Promise<number> {
	let queued = 0;
	for (const member of await CampaignRepository.listConfirmedSites()) {
		await AbuseRepository.enqueueJobOnce({ ...linkJob(member, label), nextAttemptAt: new Date(now.getTime() + queued * SWEEP_SPACING_MS) });
		queued += 1;
	}
	return queued;
}

const RULES_SWEEP = "campaign-link:rules-v";

/**
 * The sweep the current rules ask for; a start that already queued it queues
 * nothing. An older rules sweep still waiting is dropped: the new one links
 * every site again anyway.
 */
export async function enqueueRulesSweep(): Promise<number> {
	await AbuseRepository.discardQueuedJobs(RULES_SWEEP, `${RULES_SWEEP}${CAMPAIGN_RULES_VERSION}:`);
	return enqueueCampaignSweep(`rules-v${CAMPAIGN_RULES_VERSION}`);
}

/**
 * Link one confirmed site of a case, named by the case and the site's
 * report: fill in kit files the case's capture did not record when the
 * site is the case's headline site (the files are its page's), record what
 * the site shows into its campaign, have the campaign described, and keep
 * the campaign's kit search running. The site is always linked by what it
 * has: urlscan being busy only puts the backfill off, to a link job of its
 * own once urlscan may answer again. A report that is no site of the case
 * (a data drop's) links nothing.
 */
export async function linkSiteToCampaign(params: CampaignMember, dependencies: LinkDependencies & KitBackfillDependencies = {}): Promise<bigint | undefined> {
	const site = await CampaignRepository.siteOf(params);
	if (site === undefined) return undefined;
	const member = { ...params, site };
	const submission = await (dependencies.loadSubmission ?? SubmissionsEntity.get)(params.submissionId);
	if (submission?.data.kind === "website" && headlineSite(submission.data.website) === site) {
		const event = (data: Record<string, unknown>) => AbuseRepository.appendEvent({ reportId: params.reportId, eventType: "kit_backfill.checked", data });
		try {
			const backfill = await backfillKitResources(params.submissionId, dependencies);
			if (backfill.kind === "matched" || backfill.kind === "no_match") await event(backfill);
		} catch (error) {
			if (isUrlscanBusy(error)) {
				const retryAt = new Date(Date.now() + urlscanRetryAfterMs(error));
				await event({ kind: "deferred", reason: errorSummary(error), retryAt: retryAt.toISOString() });
				await AbuseRepository.enqueueJob({ ...linkJob(params, "backfill"), nextAttemptAt: retryAt });
			} else {
				await event({ kind: "failed", reason: errorSummary(error) });
			}
		}
	}
	const campaignId = await linkSiteMember(member, dependencies);
	if (campaignId === undefined) return undefined;
	await AbuseRepository.enqueueJob({
		jobType: "describe_campaign",
		reportId: params.reportId,
		payload: { campaignId: campaignId.toString() },
		dedupeKey: `campaign-describe:${campaignId.toString()}`,
		nextAttemptAt: new Date(Date.now() + DESCRIBE_AFTER_MS),
	});
	await armCampaignKitSearch(campaignId);
	return campaignId;
}
