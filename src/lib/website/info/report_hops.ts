import { isSameWebsite } from "./site";
import { offeredDownloadSource } from "../visit/offered_download";
import { normalizedEvidence, QUOTE_GAP, verbatimEvidenceQuote, type WebsiteEvidenceArchive } from "../analysis/classification";
import type { ReportableWebsiteFinding, WebsiteNavigationHop, WebsiteSiteAssessment, WebsiteSiteClassification } from "../types";

export function websiteSiteAssessments(
	hops: WebsiteNavigationHop[],
	capturedHopIndex: number,
	capturedClassification: WebsiteSiteClassification,
): WebsiteSiteAssessment[] {
	const capturedHop = hops.find((hop) => hop.index === capturedHopIndex && hop.contentCaptured);
	return hops.map((hop) => ({
		hopIndex: hop.index,
		// A redirect within the captured site is part of it. A redirect response
		// on another site has no captured page of its own and cannot inherit the
		// destination's classification or trigger a report.
		...(capturedHop && isSameWebsite(hop.url, capturedHop.url)
			? capturedClassification
			: { finding: "insufficient_evidence" as const }),
	}));
}

/**
 * Every URL of the captured site in the navigation, captured page first:
 * single-URL providers receive the page itself, while URL lists also cover
 * the same-site link a visitor actually received.
 */
export function websiteReportUrls(hops: WebsiteNavigationHop[], capturedHop: WebsiteNavigationHop): string[] {
	return [...new Set([capturedHop.url, ...hops.filter((hop) => isSameWebsite(hop.url, capturedHop.url)).map((hop) => hop.url)])];
}

/**
 * The navigation as if the captured site had been submitted directly: the
 * trailing run of hops on that site, ending at the captured page.
 */
export function capturedHostNavigation(hops: WebsiteNavigationHop[], capturedHop: WebsiteNavigationHop): WebsiteNavigationHop[] {
	const end = hops.findIndex((hop) => hop.index === capturedHop.index);
	let start = end;
	while (start > 0 && isSameWebsite(hops[start - 1]!.url, capturedHop.url)) start--;
	return hops.slice(start, end + 1).map((hop, index) => ({ ...hop, index }));
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
	archive: Pick<WebsiteEvidenceArchive, "url" | "text" | "hiddenFrames" | "offeredDownload">,
): WebsiteNavigationHop | undefined {
	const capturedHop = hops.find((hop) => hop.contentCaptured && hop.url === archive.url);
	if (!capturedHop) return undefined;
	const assessment = assessments.find((candidate) => candidate.hopIndex === capturedHop.index);
	if ((assessment?.finding !== "phishing" && assessment?.finding !== "malware") || !assessment.evidenceQuote) return undefined;
	const download = assessment.offeredDownload && archive.offeredDownload?.sha256 === assessment.offeredDownload.sha256 ? archive.offeredDownload : undefined;
	const source = assessment.hiddenFrame
		? archive.hiddenFrames?.find((frame) => frame.ref === assessment.hiddenFrame!.ref && frame.url === assessment.hiddenFrame!.url)?.source
		: assessment.offeredDownload
			? download && offeredDownloadSource(download)
			: archive.text.toString("utf-8");
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

export const isReportable = (classification: WebsiteSiteClassification) => classification.finding === "phishing" || classification.finding === "malware";
