import type { Artifact } from "@/lib/db/schema";
import type { SubmissionDetail } from "@/lib/submissions/details";
import type { WebsitePhishingBasis } from "@/lib/website/types";
import { websiteSite } from "@/lib/website/info/site";

export type WebsiteData = Extract<SubmissionDetail["data"], { kind: "website" }>["website"];
export type NavigationHop = NonNullable<WebsiteData["navigationHops"]>[number];
export type SiteAssessment = NonNullable<WebsiteData["siteAssessments"]>[number];

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

/** Each site of the chain confirmed as phishing or malware, once, in the order the chain reached it, with its verdict. */
export function reportedSites(hops: readonly NavigationHop[], assessments: ReadonlyMap<number, SiteAssessment>): Array<{ site: string; assessment: SiteAssessment }> {
	const sites = new Map<string, SiteAssessment>();
	for (const hop of hops) {
		const assessment = assessments.get(hop.index);
		const site = websiteSite(hop.url);
		if (isReportable(assessment) && !sites.has(site)) sites.set(site, assessment!);
	}
	return [...sites].map(([site, assessment]) => ({ site, assessment }));
}

/** The headline for the page a finding rests on, in the sidebar verdict. */
export function verdictLabelOf(assessment: SiteAssessment | undefined): string | undefined {
	if (assessment?.finding === "phishing") return assessment.phishingBasis ? `Phishing: ${PHISHING_BASIS_LABELS[assessment.phishingBasis]}` : "Phishing";
	if (assessment?.finding === "malware") {
		return assessment.hiddenFrame ? "Malware: drive-by exploit in a hidden frame" : assessment.offeredDownload ? "Malware: the file it offers" : "Malware distribution";
	}
	return undefined;
}

/** The per-hop finding line of the navigation tab. */
export function hopFindingLabel(assessment: SiteAssessment | undefined): string | undefined {
	switch (assessment?.finding) {
		case "prank_or_troll": return "Prank / troll — not phishing";
		case "insufficient_evidence": return "Insufficient evidence";
		case "phishing": return assessment.phishingBasis ? `Phishing — ${PHISHING_BASIS_LABELS[assessment.phishingBasis]}` : "Phishing";
		case "malware": return assessment.hiddenFrame ? "Malware — drive-by exploit in a hidden frame" : assessment.offeredDownload ? "Malware — the file it offers" : "Malware distribution";
		case "benign": return "Not phishing or malware";
		default: return undefined;
	}
}
