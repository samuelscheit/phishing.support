import type { SubmissionData } from "@/lib/db/schema";
import type { WebsiteSiteFinding } from "@/lib/website/types";

/**
 * The finding a case stands at: a website's verdict on the site of its
 * headline page (the analyzed page of its analyzed route). An email keeps no
 * finding of its own, its status says it all, and a website that showed no
 * page has none either.
 */
export function caseFinding(data: SubmissionData): WebsiteSiteFinding | undefined {
	if (data.kind !== "website") return undefined;
	const route = data.website.routes?.[data.website.analyzedRoute ?? 0];
	if (route?.analyzedHopIndex === undefined) return undefined;
	return route.siteAssessments?.find((assessment) => assessment.hopIndex === route.analyzedHopIndex)?.finding;
}
