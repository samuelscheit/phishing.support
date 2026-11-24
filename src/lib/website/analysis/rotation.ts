import { isBrowserUnavailable, type FabricEgress } from "../../browser/fabric";
import type { BrowserIdentity } from "../../browser/page";
import { reporterBrowserIdentity } from "../../browser/reporter_identity";
import { errorText } from "../../util/error_text";
import { isBrowserInfrastructureFailure } from "../archive/errors";
import { websiteSite } from "../info/site";
import type { WebsiteDevice, WebsiteNavigationHop, WebsiteRotation, WebsiteRotationVisit, WebsiteRouteVisitor } from "../types";
import { isPageHop } from "../visit/capture_files";
import type { WebsiteCapture } from "./analysis_types";

/**
 * Offer rotation. An affiliate network's smart link sends each click to
 * whichever offer it rotates to (production case 383412636961738752: one
 * click of an Everflow link went through wtrck.com to a fake application at
 * smizeprize.com and on to a merchant's checkout, the reporter's own click to
 * a "Your Cloud Storage has been Disabled" scam on DigitalOcean Spaces). A
 * case's first walk sees one offer; the others are only seen by opening the
 * link again, in a browser like a victim's: plain HTTP clients are sent to a
 * harmless site by the trackers' bot filters.
 */

/** How many more times a link whose first walk passed a tracking link is opened. */
export const ROTATION_VISITS = 3;
/** How long after the first walk ended sampling may start another visit; a visit already started runs to its own end. */
export const ROTATION_BUDGET_MS = 30 * 60_000;
/** Sampled visits all come from the residential exit: a smart link's bot filter sends data-centre and Tor addresses to a harmless site. */
export const ROTATION_EGRESS: FabricEgress = "residential";
/**
 * Cases the system opens by itself and re-runs on a schedule (a redirector
 * watch's daily check, a kit's sibling host) walk their link once: sampling
 * them would spend the residential exit, which a smart link's operator bans,
 * on every automated run. Their retries too, since this reads the stored source.
 */
export function samplesRotation(source: string | null | undefined): boolean {
	return !/^(redirector-watch|kit-sibling):/.test(source ?? "");
}
/** Two sampled visits in a row that only showed known routes: the link has no more offers this case would see. */
const MAX_UNCHANGED_VISITS = 2;

/** A browser a sampled visit presents: its name, and how the capture presents it. */
export type RotationBrowser = { label: string; visitor?: BrowserIdentity; device?: WebsiteDevice };

/** What a case's first walk presented: the reporter's own browser, else the capture's Chrome on Windows. */
export function firstWalkBrowser(reporter: BrowserIdentity | undefined): RotationBrowser {
	return reporter ? { label: "The reporter's browser", visitor: reporter } : WINDOWS_CHROME;
}

const WINDOWS_CHROME: RotationBrowser = { label: "Chrome on Windows" };
/**
 * Chrome on a Mac, as a Mac's Chrome sends it. Kits and trackers pick their
 * offer by platform; a fixed recent release is what a Mac in use reports.
 */
const MACOS_CHROME: RotationBrowser = {
	label: "Chrome on macOS",
	visitor: reporterBrowserIdentity({
		"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
		"sec-ch-ua": "\"Google Chrome\";v=\"141\", \"Not?A_Brand\";v=\"8\", \"Chromium\";v=\"141\"",
		"accept-language": "en-US,en;q=0.9",
	}),
};
const IPHONE_SAFARI: RotationBrowser = { label: "Safari on iPhone", device: "iphone" };

/**
 * The browsers the sampled visits present, in order: each a desktop or phone
 * the first walk was not, then the first walk's own again. A rotation decides
 * per click and per platform, so every visit is a new click in a new browser.
 */
export function rotationBrowsers(first: RotationBrowser): RotationBrowser[] {
	const others = [WINDOWS_CHROME, MACOS_CHROME, IPHONE_SAFARI].filter((browser) => browser.label !== first.label);
	return [...others, first].slice(0, ROTATION_VISITS);
}

/**
 * What tells a route apart: the sites it showed pages on, in order (the
 * lure's, then the merchant's), each once however many steps the visit made
 * there. The hops between them are not: trackers hand out new click ids and
 * tokens on every click and add or skip a hop of their own (production case
 * 383429267624562688: one walk took a wtrck.com 307 to its own /2 path, the
 * next did not), so a route named by its redirects is new on every click.
 */
export function routePageSites(hops: readonly WebsiteNavigationHop[]): string[] {
	const sites: string[] = [];
	for (const hop of hops) {
		const site = isPageHop(hop) ? siteOf(hop.url) : undefined;
		if (site && site !== sites.at(-1)) sites.push(site);
	}
	return sites;
}

/**
 * The known route a sampled visit only showed again, if any. The visit is
 * compared before it is walked, so it has shown its first page at most; it
 * repeats a route whose pages it showed so far, in the same order.
 */
export function knownRoute(visit: readonly WebsiteNavigationHop[], routes: ReadonlyArray<readonly WebsiteNavigationHop[]>): number | undefined {
	const shown = routePageSites(visit);
	const known = routes.findIndex((hops) => {
		const sites = routePageSites(hops);
		return shown.every((site, index) => sites[index] === site);
	});
	return known < 0 ? undefined : known;
}

function siteOf(url: string): string | undefined {
	try {
		return websiteSite(url);
	} catch {
		return undefined;
	}
}

/**
 * Open the submitted link again up to `ROTATION_VISITS` times, each from the
 * residential exit in another browser with a fresh profile, and walk every
 * route not seen yet in full, as the first walk was (`walk`). A visit that
 * only reached a known route is kept as its hops, the evidence that the link
 * rotates. Sampling stops early after two visits in a row showed nothing
 * new, once its time budget is used up, or when the residential exit is
 * down. A visit the browser service failed (a dropped connection, a detached
 * frame) says nothing about the exit or the link: it is kept as its error,
 * and the next browser goes on. A route whose walk failed ends the sampling,
 * as its files may be partly stored under its number.
 * `routes` are the hops of every route so far, the first walk's first; each
 * walked route is added to it.
 */
export async function sampleRotation(params: {
	routes: WebsiteNavigationHop[][];
	first: RotationBrowser;
	/** Open the link in the browser; the capture comes back with its session open. */
	capture: (browser: RotationBrowser) => Promise<WebsiteCapture>;
	/** Walk a new route from its capture, as its route number; returns its whole chain. The walk closes the capture's session. */
	walk: (archive: WebsiteCapture, browser: RotationBrowser, route: number) => Promise<WebsiteNavigationHop[]>;
	budgetMs?: number;
	now?: () => number;
}): Promise<WebsiteRotation> {
	const now = params.now ?? Date.now;
	const startedAt = now();
	const budgetMs = params.budgetMs ?? ROTATION_BUDGET_MS;
	const visits: WebsiteRotationVisit[] = [];
	let unchanged = 0;
	const browsers = rotationBrowsers(params.first);
	for (const browser of browsers) {
		if (now() - startedAt >= budgetMs) return { visits, ended: `The time for sampling the link's other offers (${Math.round(budgetMs / 60_000)} min) was used up.` };
		const visitor: WebsiteRouteVisitor = { browser: browser.label, network: "residential exit" };
		const started = new Date(now()).toISOString();
		let archive: WebsiteCapture;
		try {
			archive = await params.capture(browser);
		} catch (error) {
			visits.push({ startedAt: started, visitor, error: errorText(error) });
			// A lease that failed, or a link the exit could not reach, is the exit; anything else not of the browser service is not known to pass.
			if (!isBrowserUnavailable(error) && isBrowserInfrastructureFailure(error)) continue;
			return { visits, ended: `Opening the link again from the residential exit failed: ${errorText(error)}` };
		}
		const known = knownRoute(archive.navigationHops, params.routes);
		if (known !== undefined) {
			// A browser that will not close is no reason to lose the routes already walked.
			await archive.session?.close().catch(() => undefined);
			visits.push({ startedAt: started, visitor, repeatOf: known, hops: archive.navigationHops });
			if (++unchanged >= MAX_UNCHANGED_VISITS) return { visits, ended: `${MAX_UNCHANGED_VISITS} visits in a row showed only routes seen before.` };
			continue;
		}
		unchanged = 0;
		const route = params.routes.length;
		try {
			const hops = await params.walk(archive, browser, route);
			params.routes.push(hops);
		} catch (error) {
			// A route whose walk broke off may have stored some of its files; no later route takes its number.
			visits.push({ startedAt: started, visitor, error: errorText(error) });
			return { visits, ended: `Walking a new route failed: ${errorText(error)}` };
		}
		visits.push({ startedAt: started, visitor, route });
	}
	return { visits, ended: `All ${browsers.length} visits were made.` };
}
