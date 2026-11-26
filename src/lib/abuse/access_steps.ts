import { SubmissionsEntity } from "../db/entities/submissions";
import type { WebsiteSubmissionData } from "../db/schema";
import type { WebsiteAccessStep } from "../website/types";

/**
 * The access steps of the walk that reached a report's URLs: the route
 * whose pages include one of them, else the route the case's verdict rests
 * on. None when that walk did nothing in a page.
 */
export function websiteAccessSteps(website: WebsiteSubmissionData, observedUrls: readonly string[]): WebsiteAccessStep[] {
	const routes = website.routes ?? [];
	const urls = new Set(observedUrls);
	const route = routes.find((candidate) => candidate.hops.some((hop) => urls.has(hop.url))) ?? routes[website.analyzedRoute ?? 0];
	// A visit recorded before access steps were kept has none.
	return route?.visit?.accessSteps ?? [];
}

/** The access steps of a report's case, read from the case's stored walk. */
export async function reportAccessSteps(submissionId: bigint | null, observedUrls: readonly string[]): Promise<WebsiteAccessStep[]> {
	if (submissionId === null) return [];
	const submission = await SubmissionsEntity.get(submissionId);
	return submission?.data.kind === "website" ? websiteAccessSteps(submission.data.website, observedUrls) : [];
}
