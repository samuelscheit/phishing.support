import { extractFunnel } from "../../abuse/funnel/extract";
import type { FabricEgress } from "../../browser/fabric";
import type { BrowserIdentity } from "../../browser/page";
import { reporterBrowserIdentity } from "../../browser/reporter_identity";
import { errorText } from "../../util/error_text";
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
 * Where a route leads once the link's own redirects are behind it: the first
 * site after the submitted one that is no tracking link or wrapper (`via`),
 * and the site of the first page it showed (`landing`). Two visits with the
 * same of both took the same route; a rotation shows another offer on
 * either. Only the hops up to the first page count: a sampled visit is
 * compared before it is walked any further.
 */
export function routeDestination(hops: readonly WebsiteNavigationHop[], submittedUrl: string): { via?: string; landing?: string } {
	const firstPage = hops.findIndex(isPageHop);
	const reached = firstPage < 0 ? hops : hops.slice(0, firstPage + 1);
	const page = firstPage < 0 ? undefined : reached.at(-1);
	const { hopKinds } = extractFunnel({ hops: reached, pages: page ? [{ hopIndex: page.index, url: page.url, text: "", capturedAt: new Date(0) }] : [] });
	const passedThrough = new Set(hopKinds.filter(({ kind }) => kind === "tracker" || kind === "redirector").map(({ hopIndex }) => hopIndex));
	const submitted = siteOf(submittedUrl);
	const via = reached.find((hop) => !passedThrough.has(hop.index) && siteOf(hop.url) !== submitted);
	return { ...(via ? { via: siteOf(via.url) } : {}), ...(page ? { landing: siteOf(page.url) } : {}) };
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
 * new, once its time budget is used up, or when a visit fails: the
 * residential exit is a single connection a failure is not retried through.
 * `routes` are the hops of every route so far, the first walk's first; each
 * walked route is added to it.
 */
export async function sampleRotation(params: {
	url: string;
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
	const destinations = params.routes.map((hops) => routeDestination(hops, params.url));
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
			return { visits, ended: `Opening the link again from the residential exit failed: ${errorText(error)}` };
		}
		const destination = routeDestination(archive.navigationHops, params.url);
		const known = destinations.findIndex((other) => other.via === destination.via && other.landing === destination.landing);
		if (known >= 0) {
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
			destinations.push(destination);
		} catch (error) {
			// A route whose walk broke off may have stored some of its files; no later route takes its number.
			visits.push({ startedAt: started, visitor, error: errorText(error) });
			return { visits, ended: `Walking a new route failed: ${errorText(error)}` };
		}
		visits.push({ startedAt: started, visitor, route });
	}
	return { visits, ended: `All ${browsers.length} visits were made.` };
}
