import type { WebsiteSubmissionData } from "../db/schema";
import { websiteSite } from "../website/info/site";
import { analyzedCaptureStep, analyzedPage, isPageHop, pageCaptureStep } from "../website/visit/capture_files";

/**
 * One member of a campaign: a site one case confirmed, named by the case and
 * the site's primary report, which the case filed itself or joined. A case
 * whose chain confirmed two sites is two members; a case whose site another
 * case already reports is a member through that report, with its own
 * capture of the site.
 */
export type CampaignMember = { submissionId: bigint; reportId: bigint };

/** A member with the site its report is about (`websiteSite`). */
export type CampaignSite = CampaignMember & { site: string };

/** A member as one string: what campaigns are clustered and looked up by. */
export function memberKey(member: CampaignMember): string {
	return `${member.submissionId.toString()}:${member.reportId.toString()}`;
}

/** The site of a stored URL (`websiteSite`), or undefined when it does not parse. */
export function siteOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return websiteSite(url);
	} catch {
		return undefined;
	}
}

/**
 * The site a report's first target stands for, as reports are deduplicated
 * across cases: its first reported URL's (the site's judged page), else its host.
 */
export function reportSite(target: { normalizedTarget: string; observedUrls: readonly string[] }): string {
	return siteOf(target.observedUrls[0]) ?? target.normalizedTarget;
}

type CaseChain = Pick<WebsiteSubmissionData, "url" | "archiveUrl" | "navigationHops" | "analyzedHopIndex" | "siteAssessments">;

/**
 * The site of the case's headline page (`analyzedHopIndex`). What the case
 * records once rather than per site – its kit files and their urlscan
 * backfill, the hidden frames and the payloads its investigation fetched –
 * was recorded for that page, so it belongs to that site alone.
 */
export function headlineSite(website: CaseChain): string | undefined {
	return siteOf(analyzedPage(website)?.hop.url ?? website.archiveUrl ?? website.url);
}

/** The capture step a page screenshot's file name is of: the inverse of `websiteCaptureFileNames(step).screenshot`. */
export function screenshotStep(name: string): number | undefined {
	const match = /^website(?:-step(\d+))?\.png$/.exec(name);
	return match ? (match[1] ? Number(match[1]) - 1 : 0) : undefined;
}

/** A captured page of the case: its URL and the step its capture files are named after (`websiteCaptureFileNames`). */
export type SitePage = { url: string; step: number };

/**
 * The page a case's verdict on one site rests on: the site's judged page
 * (`judgedHopIndex` of its assessment). A case that judged no page of the
 * site by itself (one recorded before sites were judged in-case) has its
 * headline page for its headline site, and none for any other.
 */
export function judgedSitePage(website: CaseChain, site: string): SitePage | undefined {
	const hops = website.navigationHops ?? [];
	for (const assessment of website.siteAssessments ?? []) {
		if (assessment.judgedHopIndex === undefined || siteOf(hops.find((hop) => hop.index === assessment.hopIndex)?.url) !== site) continue;
		const judged = hops.find((hop) => hop.index === assessment.judgedHopIndex && isPageHop(hop));
		if (judged) return { url: judged.url, step: pageCaptureStep(hops, judged) };
	}
	if (headlineSite(website) !== site) return undefined;
	const analyzed = analyzedPage(website);
	return analyzed ? { url: analyzed.hop.url, step: analyzed.step } : { url: website.archiveUrl ?? website.url, step: analyzedCaptureStep(hops) };
}

/**
 * The capture steps of every page of the site the case was shown, in chain
 * order. Undefined when every captured page is the site's: a case without a
 * recorded chain showed its headline site and nothing else.
 */
export function sitePageSteps(website: CaseChain, site: string): number[] | undefined {
	const hops = website.navigationHops ?? [];
	if (!hops.length) return headlineSite(website) === site ? undefined : [];
	return [...new Set(hops.filter((hop) => isPageHop(hop) && siteOf(hop.url) === site).map((hop) => pageCaptureStep(hops, hop)))];
}
