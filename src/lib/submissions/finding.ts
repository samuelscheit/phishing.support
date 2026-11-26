import type { SubmissionData, SubmissionKind } from "@/lib/db/schema";
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

/**
 * What a reported case was reported for, by its findings across every route:
 * its confirmed sites (phishing, malware or both), else the deceptive funnel a
 * route is. An email is reported only as phishing.
 */
export type ReportedAs = "phishing" | "malware" | "phishing_and_malware" | "deceptive_funnel";

/** What a case was reported for, from what it found; undefined when it found none of it (a case reported before its verdicts were kept). */
export function reportedAsOf(kind: SubmissionKind, found: { phishing: boolean; malware: boolean; deceptiveFunnel: boolean }): ReportedAs | undefined {
	if (kind === "email") return "phishing";
	if (found.phishing && found.malware) return "phishing_and_malware";
	if (found.phishing) return "phishing";
	if (found.malware) return "malware";
	return found.deceptiveFunnel ? "deceptive_funnel" : undefined;
}

/** `reportedAsOf` read from the case data. */
export function caseReportedAs(data: SubmissionData): ReportedAs | undefined {
	const routes = data.kind === "website" ? data.website.routes ?? [] : [];
	const findings = new Set(routes.flatMap((route) => (route.siteAssessments ?? []).map((assessment) => assessment.finding)));
	return reportedAsOf(data.kind, {
		phishing: findings.has("phishing"),
		malware: findings.has("malware"),
		deceptiveFunnel: routes.some((route) => route.funnel?.verdict.finding === "deceptive_funnel"),
	});
}
