import { isFlowStepHop, type WebsiteNavigationHop } from "../types";

/**
 * File names of one captured page of a website case. A chain can spread over
 * several pages and sites; the capture follows the visit and keeps every page
 * it saw. The first page is `website.*`; each page reached by following a link,
 * acting on a page, or opening it again is `website-step<n>.*`, numbered from 1
 * for the first page.
 */
export function websiteCaptureFileNames(step: number) {
	const stem = step === 0 ? "website" : `website-step${step + 1}`;
	const manifest = step === 0 ? "evidence-manifest" : `evidence-step${step + 1}-manifest`;
	return {
		mhtml: `${stem}.mhtml`,
		screenshot: `${stem}.png`,
		stampedScreenshot: `${stem}-stamped.png`,
		manifest: `${manifest}.json`,
		timestamp: `${manifest}.tsr`,
	};
}

/** The raw body of one document answer of the chain, as the network delivered it (`bodyCaptured`). */
export function chainHopBodyFileName(hopIndex: number): string {
	return `chain-hop-${hopIndex}.html`;
}

/** The step of a capture's own page: one per link the capture followed, page action it took, or phone it reopened the page as to reach it. */
export function analyzedCaptureStep(navigationHops: readonly WebsiteNavigationHop[] | undefined): number {
	return navigationHops?.filter(isFlowStepHop).length ?? 0;
}

/** A hop whose page was shown and captured: a page the visit moved on from or opened again, or the last page shown. */
export function isPageHop(hop: WebsiteNavigationHop): boolean {
	return hop.contentCaptured || isFlowStepHop(hop);
}

/** The step whose capture files hold a page of the chain. */
export function pageCaptureStep(hops: readonly WebsiteNavigationHop[], page: WebsiteNavigationHop): number {
	return hops.filter((hop) => isFlowStepHop(hop) && hop.index < page.index).length;
}

/** The page a website case's verdict rests on, with the step its capture files are named after. */
export function analyzedPage(website: { navigationHops?: WebsiteNavigationHop[]; analyzedHopIndex?: number }): { hop: WebsiteNavigationHop; step: number } | undefined {
	const hops = website.navigationHops ?? [];
	const hop = hops.find((candidate) => candidate.index === website.analyzedHopIndex && isPageHop(candidate));
	return hop ? { hop, step: pageCaptureStep(hops, hop) } : undefined;
}

/** The navigation as it stood when a page of the chain was shown: every hop up to it, that page the captured one. */
export function navigationToPage(hops: readonly WebsiteNavigationHop[], page: WebsiteNavigationHop): WebsiteNavigationHop[] {
	return hops.filter((hop) => hop.index <= page.index).map((hop) => {
		if (hop.index !== page.index) return hop;
		const { redirectTo: _redirectTo, visitorStep: _visitorStep, revisit: _revisit, ...shown } = hop;
		return { ...shown, contentCaptured: true };
	});
}

/** The newest artifact with this name; a retry may store the same page again. */
export function latestArtifactNamed<T extends { id: bigint | string; name: string | null }>(artifacts: readonly T[], name: string): T | undefined {
	return artifacts
		.filter((artifact) => artifact.name === name)
		.reduce<T | undefined>((latest, artifact) => (!latest || BigInt(artifact.id) > BigInt(latest.id) ? artifact : latest), undefined);
}
