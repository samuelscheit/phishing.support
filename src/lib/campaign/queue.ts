import { AbuseRepository } from "../abuse/repository";
import type { CampaignMember } from "./members";
import { CampaignRepository } from "./repository";

/**
 * The dedupe key of a member's link job: by case and site report, so each
 * site a case reported or joined is linked, and only once at a time. A
 * sweep's or a deferred backfill's job carries its `label`.
 */
export function linkJobKey(member: CampaignMember, label?: string): string {
	return `campaign-link:${label ? `${label}:` : ""}${member.submissionId.toString()}:${member.reportId.toString()}`;
}

/** The link job of one member; its report is the job's. */
export function linkJob(member: CampaignMember, label?: string) {
	return { jobType: "link_campaign" as const, reportId: member.reportId, payload: { submissionId: member.submissionId.toString() }, dedupeKey: linkJobKey(member, label) };
}

/**
 * Link every site a website case confirmed again, each as its own member:
 * when one of the case's reports resolved (a site report, or a data drop its
 * investigation reported, which adds to the site it came from), and when the
 * case joined another case's report of a site. Returns how many were queued.
 */
export async function queueCaseSiteLinks(submissionId: bigint): Promise<number> {
	const sites = await CampaignRepository.listCaseSites(submissionId);
	for (const member of sites) await AbuseRepository.enqueueJob(linkJob(member));
	return sites.length;
}
