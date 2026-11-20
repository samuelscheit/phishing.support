import { AbuseRepository } from "../abuse/repository";
import { isUrlscanBusy, urlscanRetryAfterMs } from "../abuse/origin/urlscan";
import { errorSummary } from "../error_text";
import { backfillKitResources, type KitBackfillDependencies } from "./kit_backfill";
import { armCampaignKitSearch } from "./kit_search";
import { linkSubmissionToCampaign, type LinkDependencies } from "./link";
import { CampaignRepository } from "./repository";

/**
 * Bump when what a site's indicators are, or where they come from, changes:
 * on the next start every confirmed site is linked again, once.
 */
export const CAMPAIGN_RULES_VERSION = 7;
/** Sites of a sweep are linked this far apart: each may ask urlscan for its kit files. */
const SWEEP_SPACING_MS = 20_000;
/** Sites of one campaign arrive in bursts: it is described once the burst settles. */
const DESCRIBE_AFTER_MS = 5 * 60_000;

/** Queue every confirmed site's link job, once per `label`; returns how many sites the sweep covers. */
export async function enqueueCampaignSweep(label: string, now = new Date()): Promise<number> {
	let queued = 0;
	for (const submissionId of await CampaignRepository.listReportedWebsiteSubmissionIds()) {
		const report = await AbuseRepository.getReportForSubmission(submissionId);
		if (!report) continue;
		await AbuseRepository.enqueueJobOnce({
			jobType: "link_campaign",
			reportId: report.id,
			payload: { submissionId: submissionId.toString() },
			dedupeKey: `campaign-link:${label}:${submissionId.toString()}`,
			nextAttemptAt: new Date(now.getTime() + queued * SWEEP_SPACING_MS),
		});
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
 * Link one confirmed site: fill in kit files its capture did not record,
 * record what it shows into its campaign, have the campaign described, and
 * keep the campaign's kit search running. The site is always linked by what
 * it has: urlscan being busy only puts the backfill off, to a link job of
 * its own once urlscan may answer again.
 */
export async function linkSiteToCampaign(params: { submissionId: bigint; reportId: bigint }, dependencies: LinkDependencies & KitBackfillDependencies = {}): Promise<bigint | undefined> {
	const event = (data: Record<string, unknown>) => AbuseRepository.appendEvent({ reportId: params.reportId, eventType: "kit_backfill.checked", data });
	try {
		const backfill = await backfillKitResources(params.submissionId, dependencies);
		if (backfill.kind === "matched" || backfill.kind === "no_match") await event(backfill);
	} catch (error) {
		if (isUrlscanBusy(error)) {
			const retryAt = new Date(Date.now() + urlscanRetryAfterMs(error));
			await event({ kind: "deferred", reason: errorSummary(error), retryAt: retryAt.toISOString() });
			await AbuseRepository.enqueueJob({
				jobType: "link_campaign",
				reportId: params.reportId,
				payload: { submissionId: params.submissionId.toString() },
				dedupeKey: `campaign-link:backfill:${params.submissionId.toString()}`,
				nextAttemptAt: retryAt,
			});
		} else {
			await event({ kind: "failed", reason: errorSummary(error) });
		}
	}
	const campaignId = await linkSubmissionToCampaign(params.submissionId, dependencies);
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
