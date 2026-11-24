import { isReportable } from "./info/report_hops";
import { websiteSite } from "./info/site";
import type { WebsiteNavigationHop, WebsiteRoute, WebsiteSiteAssessment } from "./types";
import { routePage, type CapturePage } from "./visit/capture_files";

/** The routes of a website case, the first walk's first. */
export function websiteRoutes(website: { routes?: WebsiteRoute[] }): WebsiteRoute[] {
	return website.routes ?? [];
}

/** Every site verdict of every route, each with the route it was given on. */
export function routeSiteAssessments(website: { routes?: WebsiteRoute[] }): Array<WebsiteSiteAssessment & { route: number }> {
	return websiteRoutes(website).flatMap((walked, route) => (walked.siteAssessments ?? []).map((assessment) => ({ ...assessment, route })));
}

/**
 * Where a case found `site` reportable: the first route whose verdict on it is
 * phishing or malware, its chain, the verdict, and the judged page with its
 * capture files. Undefined when no route found the site reportable.
 */
export function reportedSiteRoute(website: { routes?: WebsiteRoute[] }, site: string): {
	route: number;
	hops: WebsiteNavigationHop[];
	assessment: WebsiteSiteAssessment;
	judged?: { hop: WebsiteNavigationHop; page: CapturePage };
} | undefined {
	for (const [route, walked] of websiteRoutes(website).entries()) {
		const assessment = (walked.siteAssessments ?? []).find((candidate) => isReportable(candidate) && walked.hops.some((hop) => hop.index === candidate.hopIndex && websiteSite(hop.url) === site));
		if (!assessment) continue;
		const hop = walked.hops.find((candidate) => candidate.index === assessment.judgedHopIndex);
		return { route, hops: walked.hops, assessment, ...(hop ? { judged: { hop, page: routePage(route, walked.hops, hop) } } : {}) };
	}
	return undefined;
}
