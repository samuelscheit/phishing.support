import { websiteSite } from "../info/site";
import { isFlowStepHop, type WebsiteNavigationHop, type WebsiteRoute } from "../types";

/**
 * A captured page of a website case: the route (walk of the submitted link)
 * it was shown on and its step in that walk. Its capture files are named
 * after both.
 */
export type CapturePage = { route: number; step: number };

/**
 * What every file of a route starts with: nothing for the case's first walk,
 * `route<n>-` (numbered from 1) for each route a later visit of a rotating
 * link took, so no route's files take another's name.
 */
function routePrefix(route: number): string {
	return route === 0 ? "" : `route${route + 1}-`;
}

/**
 * File names of one captured page of a website case. A chain can spread over
 * several pages and sites; the capture follows the visit and keeps every page
 * it saw. The first page is `website.*`; each page reached by following a link,
 * acting on a page, or opening it again is `website-step<n>.*`, numbered from 1
 * for the first page. A later route's files carry its prefix (`route2-website.*`).
 */
export function websiteCaptureFileNames({ route, step }: CapturePage) {
	const stem = `${routePrefix(route)}${step === 0 ? "website" : `website-step${step + 1}`}`;
	const manifest = `${routePrefix(route)}${step === 0 ? "evidence-manifest" : `evidence-step${step + 1}-manifest`}`;
	return {
		mhtml: `${stem}.mhtml`,
		screenshot: `${stem}.png`,
		stampedScreenshot: `${stem}-stamped.png`,
		/** The screenshot cut to what the page drew (`page_preview.ts`): what the case and campaign pages show. */
		preview: `${stem}-thumb.webp`,
		manifest: `${manifest}.json`,
		timestamp: `${manifest}.tsr`,
	};
}

/** The raw body of one document answer of a route's chain, as the network delivered it (`bodyCaptured`). */
export function chainHopBodyFileName(route: number, hopIndex: number): string {
	return `${routePrefix(route)}chain-hop-${hopIndex}.html`;
}

/** The files of one walk's visit record (`evidence/visit`): its record, protocol, manifest and timestamp token. */
export function visitEvidenceFileNames(route: number) {
	return {
		record: `${routePrefix(route)}visit-record.json`,
		protocol: `${routePrefix(route)}visit-protocol.txt`,
		manifest: `${routePrefix(route)}visit-manifest.json`,
		timestamp: `${routePrefix(route)}visit-manifest.tsr`,
	};
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

/** A route's own page (`hop`) as the capture files name it. */
export function routePage(route: number, hops: readonly WebsiteNavigationHop[], hop: WebsiteNavigationHop): CapturePage {
	return { route, step: pageCaptureStep(hops, hop) };
}

/** The page a website case's verdict rests on: the analyzed page of its analyzed route, with the files it is captured in. */
export function analyzedPage(website: { routes?: WebsiteRoute[]; analyzedRoute?: number }): { hop: WebsiteNavigationHop; hops: WebsiteNavigationHop[]; page: CapturePage } | undefined {
	const route = website.analyzedRoute ?? 0;
	const walked = website.routes?.[route];
	const hop = walked?.hops.find((candidate) => candidate.index === walked.analyzedHopIndex && isPageHop(candidate));
	return walked && hop ? { hop, hops: walked.hops, page: routePage(route, walked.hops, hop) } : undefined;
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

/**
 * The names of a case's routes ("Route 2 · via safe.cloudforstorage.com"):
 * every route starts at the submitted link, so each is named by the first
 * site it reached after the submitted one, as a visitor would see the link
 * leave. A route that never left the submitted site is named by its first
 * page's site. Two routes through the same first site (one tracker rotating
 * two offers) are told apart by the site of their first page.
 */
export function routeNames(routes: ReadonlyArray<readonly WebsiteNavigationHop[]>, submittedSite: string | null | undefined): Array<string | undefined> {
	const landings = routes.map((hops) => {
		const page = hops.find(isPageHop);
		return page && websiteSite(page.url);
	});
	const vias = routes.map((hops, route) => hops.map((hop) => websiteSite(hop.url)).find((site) => site !== submittedSite) ?? landings[route] ?? (hops[0] && websiteSite(hops[0].url)));
	return vias.map((via, route) => {
		const landing = landings[route];
		const shared = vias.some((other, index) => index !== route && other === via);
		return via && shared && landing && landing !== via ? `${via} to ${landing}` : via;
	});
}
