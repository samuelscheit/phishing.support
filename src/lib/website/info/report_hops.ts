import { isSameWebsite, websiteSite } from "./site";
import { classifiedEvidenceSource, normalizedEvidence, QUOTE_GAP, verbatimEvidenceQuote, type WebsiteEvidenceArchive } from "../analysis/classification";
import type { ReportableWebsiteFinding, WebsiteNavigationHop, WebsiteSiteAssessment, WebsiteSiteClassification } from "../types";

/** A site's verdict: the classification of the page it rests on. */
export type SiteVerdict = { judgedHopIndex: number; classification: WebsiteSiteClassification };

/**
 * The verdict of every hop of a chain, by its site: a redirect or a page of a
 * site shares that site's verdict. A site that only redirected showed no page
 * of its own; it never inherits where it led and has insufficient evidence.
 */
export function chainSiteAssessments(hops: readonly WebsiteNavigationHop[], verdicts: ReadonlyMap<string, SiteVerdict>): WebsiteSiteAssessment[] {
	return hops.map((hop) => {
		const verdict = verdicts.get(websiteSite(hop.url));
		return verdict ? { ...verdict.classification, hopIndex: hop.index, judgedHopIndex: verdict.judgedHopIndex } : { hopIndex: hop.index, finding: "insufficient_evidence" };
	});
}

/**
 * Every URL of the captured site in the navigation, captured page first:
 * single-URL providers receive the page itself, while URL lists also cover
 * the same-site link a visitor actually received.
 */
export function websiteReportUrls(hops: readonly WebsiteNavigationHop[], capturedHop: WebsiteNavigationHop): string[] {
	return [...new Set([capturedHop.url, ...hops.filter((hop) => isSameWebsite(hop.url, capturedHop.url)).map((hop) => hop.url)])];
}


/** The case's verdict when the analyzed page shows nothing reportable. */
export function unreportedVerdict({ finding, rejectedClaim }: WebsiteSiteClassification, url: string): string {
	if (finding === "prank_or_troll") return `The captured destination ${url} was classified as a prank or troll page, not phishing or malware; no report was created.`;
	if (rejectedClaim) return `The classifier's finding for ${url} was not corroborated by the captured page: ${rejectedClaim}. No report was created.`;
	return `No reportable phishing or malware evidence was found at the captured destination ${url}; no report was created.`;
}

/** The reported finding of a corroborated classification. */
export function reportableFinding(classification: WebsiteSiteClassification): ReportableWebsiteFinding {
	if (classification.finding === "malware") return { finding: "malware" };
	if (classification.finding === "phishing" && classification.phishingBasis) return { finding: "phishing", phishingBasis: classification.phishingBasis };
	throw new Error("A reportable classification is missing its finding or phishing basis.");
}

export function reportableWebsiteHop(
	hops: WebsiteNavigationHop[],
	assessments: WebsiteSiteAssessment[],
	archive: Pick<WebsiteEvidenceArchive, "url" | "text" | "hiddenFrames" | "offeredDownload" | "clipboardWrites">,
): WebsiteNavigationHop | undefined {
	const capturedHop = hops.find((hop) => hop.contentCaptured && hop.url === archive.url);
	if (!capturedHop) return undefined;
	const assessment = assessments.find((candidate) => candidate.hopIndex === capturedHop.index);
	if ((assessment?.finding !== "phishing" && assessment?.finding !== "malware") || !assessment.evidenceQuote) return undefined;
	const source = classifiedEvidenceSource(assessment, archive);
	if (source === undefined) return undefined;
	const stored = assessment.evidenceQuote.split(QUOTE_GAP).join("\n");
	return typeof verbatimEvidenceQuote(stored, normalizedEvidence(source)) === "string"
		? capturedHop
		: undefined;
}

export function capturedArchiveHop(archive: Pick<WebsiteEvidenceArchive, "url" | "navigationHops">): WebsiteNavigationHop {
	const capturedHops = archive.navigationHops.filter((hop) => hop.contentCaptured && hop.url === archive.url);
	if (capturedHops.length !== 1) throw new Error("Website archive must bind its content to exactly one navigation hop.");
	return capturedHops[0]!;
}

export const isReportable = (classification: Pick<WebsiteSiteClassification, "finding">) => classification.finding === "phishing" || classification.finding === "malware";
