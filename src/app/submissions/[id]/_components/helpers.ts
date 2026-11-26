import type { Artifact } from "@/lib/db/schema";
import type { DeceptiveFunnelFinding } from "@/lib/abuse/funnel/classification";
import type { SubmissionDetail } from "@/lib/submissions/details";
import type { WebsiteFunnel, WebsiteNavigationHop, WebsitePhishingBasis, WebsiteRoute, WebsiteRouteVisitor, WebsiteSiteAssessment } from "@/lib/website/types";
import { websiteSite } from "@/lib/website/info/site";
import { isPageHop } from "@/lib/website/visit/capture_files";

export type WebsiteData = Extract<SubmissionDetail["data"], { kind: "website" }>["website"];
export type NavigationHop = WebsiteNavigationHop;
export type SiteAssessment = WebsiteSiteAssessment;

const PHISHING_BASIS_LABELS: Record<WebsitePhishingBasis, string> = {
	credential_theft: "credential theft",
	payment_fraud: "payment fraud",
};

export function formatArtifactSize(value: number | bigint | null | undefined) {
	if (value === null || value === undefined) return "Unknown size";
	const bytes = typeof value === "bigint" ? Number(value) : value;
	if (!Number.isSafeInteger(bytes) || bytes < 0) return "Unknown size";
	return (bytes / 1024).toFixed(1) + " KB";
}

export function isWebsiteArchiveArtifact(artifact: Pick<Artifact, "kind">) {
	return artifact.kind.startsWith("website_");
}

/** A run of consecutive hops of the chain on one site; a chain may pass the same site twice. */
export type SiteRun = { site: string; hops: NavigationHop[] };

/** The chain as the sites it passed, in order. */
export function siteRuns(hops: readonly NavigationHop[]): SiteRun[] {
	const runs: SiteRun[] = [];
	for (const hop of hops) {
		const site = websiteSite(hop.url);
		const last = runs.at(-1);
		if (last?.site === site) last.hops.push(hop);
		else runs.push({ site, hops: [hop] });
	}
	return runs;
}

const isReportable = (assessment: SiteAssessment | undefined) => assessment?.finding === "phishing" || assessment?.finding === "malware";

/** A route's site verdicts by the hop they were given for. */
export function assessmentsByHop(route: WebsiteRoute): Map<number, SiteAssessment> {
	return new Map((route.siteAssessments ?? []).map((assessment) => [assessment.hopIndex, assessment]));
}

/** A site confirmed as phishing or malware, with the verdict of the first route that confirmed it and every route that did. */
export type ConfirmedSite = { site: string; assessment: SiteAssessment; routes: number[] };

/**
 * Each site confirmed as phishing or malware on any route, once, in the order
 * the routes reached it: a rotating link can show the same site on several
 * routes, and the site is one verdict and one report however often it showed.
 */
export function reportedSites(routes: readonly WebsiteRoute[]): ConfirmedSite[] {
	const sites = new Map<string, ConfirmedSite>();
	routes.forEach((route, index) => {
		const assessments = assessmentsByHop(route);
		for (const hop of route.hops) {
			const assessment = assessments.get(hop.index);
			if (!isReportable(assessment)) continue;
			const site = websiteSite(hop.url);
			const known = sites.get(site);
			if (!known) sites.set(site, { site, assessment: assessment!, routes: [index] });
			else if (!known.routes.includes(index)) known.routes.push(index);
		}
	});
	return [...sites.values()];
}

/** A route judged a deceptive affiliate funnel, with its index. */
export type DeceptiveRoute = { route: number; funnel: WebsiteFunnel & { verdict: DeceptiveFunnelFinding } };

/** Every route judged a deceptive affiliate funnel: each rotation of a smart link is its own affiliate's offer. */
export function deceptiveFunnels(routes: readonly WebsiteRoute[]): DeceptiveRoute[] {
	return routes.flatMap(({ funnel }, route) => (funnel?.verdict.finding === "deceptive_funnel" ? [{ route, funnel: { ...funnel, verdict: funnel.verdict } }] : []));
}

/** Whether a route found anything reportable: a phishing or malware site, or a deceptive funnel. */
export function routeHasFinding(route: WebsiteRoute): boolean {
	return (route.siteAssessments ?? []).some(isReportable) || route.funnel?.verdict.finding === "deceptive_funnel";
}

/** A route's label, numbered from 1 as the capture files are. */
export function routeLabel(route: number): string {
	return `Route ${route + 1}`;
}

/** How a walk presented itself: its browser, and its network when it was recorded. */
export function visitorLabel(visitor: WebsiteRouteVisitor): string {
	return [visitor.browser, visitor.network].filter(Boolean).join(" · ");
}

/** The headline for the page a finding rests on, in the sidebar verdict. */
export function verdictLabelOf(assessment: SiteAssessment | undefined): string | undefined {
	if (assessment?.finding === "phishing") return assessment.phishingBasis ? `Phishing: ${PHISHING_BASIS_LABELS[assessment.phishingBasis]}` : "Phishing";
	if (assessment?.finding === "malware") {
		return assessment.hiddenFrame ? "Malware: drive-by exploit in a hidden frame" : assessment.offeredDownload ? "Malware: the file it offers" : assessment.clipboardWrite ? "Malware: the command its copy button hands out" : "Malware distribution";
	}
	return undefined;
}

/** The per-hop finding line of the navigation tab. */
export function hopFindingLabel(assessment: SiteAssessment | undefined): string | undefined {
	switch (assessment?.finding) {
		case "prank_or_troll": return "Prank / troll — not phishing";
		case "insufficient_evidence": return "Insufficient evidence";
		case "phishing": return assessment.phishingBasis ? `Phishing — ${PHISHING_BASIS_LABELS[assessment.phishingBasis]}` : "Phishing";
		case "malware": return assessment.hiddenFrame ? "Malware — drive-by exploit in a hidden frame" : assessment.offeredDownload ? "Malware — the file it offers" : assessment.clipboardWrite ? "Malware — the command its copy button hands out" : "Malware distribution";
		case "benign": return "Not phishing or malware";
		default: return undefined;
	}
}
