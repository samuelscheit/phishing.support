import type { WebsiteNavigationHop } from "./website_types";

/**
 * File names of one captured page of a website case. A kit can spread its
 * flow over several pages; the capture follows the page's own links and keeps
 * every page it saw. The first page is `website.*`; each page reached by
 * following a link or submitting a field is `website-step<n>.*`, numbered from 1 for the first page.
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

/** The step of the analyzed page: one per link the capture followed or field it submitted to reach it. */
export function analyzedCaptureStep(navigationHops: readonly WebsiteNavigationHop[] | undefined): number {
	return navigationHops?.filter((hop) => hop.followedLink || hop.submittedField).length ?? 0;
}

/** The newest artifact with this name; a retry may store the same page again. */
export function latestArtifactNamed<T extends { id: bigint | string; name: string | null }>(artifacts: readonly T[], name: string): T | undefined {
	return artifacts
		.filter((artifact) => artifact.name === name)
		.reduce<T | undefined>((latest, artifact) => (!latest || BigInt(artifact.id) > BigInt(latest.id) ? artifact : latest), undefined);
}
