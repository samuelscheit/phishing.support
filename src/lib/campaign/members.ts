import type { WebsiteSubmissionData } from "../db/schema";
import { websiteSite } from "../website/info/site";
import { websiteRoutes } from "../website/routes";
import { analyzedCaptureStep, analyzedPage, isPageHop, pageCaptureStep, routePage, type CapturePage } from "../website/visit/capture_files";

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

type CaseChain = Pick<WebsiteSubmissionData, "url" | "archiveUrl" | "routes" | "analyzedRoute">;

/**
 * The site of the case's headline page (`analyzedPage`). What the case
 * records once rather than per site – its kit files and their urlscan
 * backfill, the hidden frames and the payloads its investigation fetched –
 * was recorded for that page, so it belongs to that site alone.
 */
export function headlineSite(website: CaseChain): string | undefined {
	return siteOf(analyzedPage(website)?.hop.url ?? website.archiveUrl ?? website.url);
}

/** The captured page a page screenshot's file name is of: the inverse of `websiteCaptureFileNames(page).screenshot`. */
export function screenshotPage(name: string): CapturePage | undefined {
	const match = /^(?:route(\d+)-)?website(?:-step(\d+))?\.png$/.exec(name);
	return match ? { route: match[1] ? Number(match[1]) - 1 : 0, step: match[2] ? Number(match[2]) - 1 : 0 } : undefined;
}

/** A captured page of the case: its URL, and the route and step its capture files are named after (`websiteCaptureFileNames`). */
export type SitePage = CapturePage & { url: string };

/** Pages in the order the case saw them: route by route, step by step. */
export function comparePages(a: CapturePage, b: CapturePage): number {
	return a.route - b.route || a.step - b.step;
}

/**
 * The page a case's verdict on one site rests on: the site's judged page
 * (`judgedHopIndex` of its assessment) on the first route that judged it. A
 * case that judged no page of the site by itself (one recorded before sites
 * were judged in-case) has its headline page for its headline site, and none
 * for any other.
 */
export function judgedSitePage(website: CaseChain, site: string): SitePage | undefined {
	for (const [route, walked] of websiteRoutes(website).entries()) {
		for (const assessment of walked.siteAssessments ?? []) {
			if (assessment.judgedHopIndex === undefined || siteOf(walked.hops.find((hop) => hop.index === assessment.hopIndex)?.url) !== site) continue;
			const judged = walked.hops.find((hop) => hop.index === assessment.judgedHopIndex && isPageHop(hop));
			if (judged) return { url: judged.url, ...routePage(route, walked.hops, judged) };
		}
	}
	if (headlineSite(website) !== site) return undefined;
	const analyzed = analyzedPage(website);
	const route = website.analyzedRoute ?? 0;
	return analyzed ? { url: analyzed.hop.url, ...analyzed.page } : { url: website.archiveUrl ?? website.url, route, step: analyzedCaptureStep(website.routes?.[route]?.hops) };
}

/**
 * Every page of the site the case was shown, on every route, in the order
 * the case saw them. Undefined when every captured page is the site's: a
 * case without a recorded chain showed its headline site and nothing else.
 */
export function sitePages(website: CaseChain, site: string): CapturePage[] | undefined {
	const routes = websiteRoutes(website);
	if (!routes.some((walked) => walked.hops.length)) return headlineSite(website) === site ? undefined : [];
	return routes.flatMap((walked, route) => {
		const steps = new Set(walked.hops.filter((hop) => isPageHop(hop) && siteOf(hop.url) === site).map((hop) => pageCaptureStep(walked.hops, hop)));
		return [...steps].map((step) => ({ route, step }));
	});
}
