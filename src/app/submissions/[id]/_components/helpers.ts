import type { Artifact } from "@/lib/db/schema";
import type { SubmissionDetail } from "@/lib/submissions/details";
import type { WebsitePhishingBasis } from "@/lib/website/types";

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
