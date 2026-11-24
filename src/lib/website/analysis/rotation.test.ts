import { describe, expect, test } from "bun:test";

import { PRODUCTION_URLS } from "../../abuse/funnel/test_fixtures";
import { AbuseRepository } from "../../abuse/repository";
import { useTrackingTokenSecret } from "../../abuse/security/test_helpers";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { scriptedVisitSession } from "../../site_visit/test_helpers";
import type { ArchiveWebsiteOptions, WebsiteArchiveResult } from "../archive/types";
import { websiteSite } from "../info/site";
import { navigationHop, websiteSubmission } from "../test_helpers";
import { routeNames } from "../visit/capture_files";
import { analyzeWebsite } from "./ai";
import { CLOUD_STORAGE_URLS, cloudStorageVisit, capturedPage, funnelDependencies, funnelHop, productionVisit, type ModelCall } from "./funnel_test_helpers";
import { firstWalkBrowser, rotationBrowsers, routeDestination, sampleRotation, type RotationBrowser } from "./rotation";

useTemporaryDatabase();
useTrackingTokenSecret();

const LINK = PRODUCTION_URLS.everflowLink;

/**
 * The capture of a rotating link: the first walk gets `first`, each sampled
 * visit (the ones from the residential exit) the next of `samples`, or its
 * error. Every call's options are kept.
 */
function rotatingLink(first: () => WebsiteArchiveResult, samples: Array<(() => WebsiteArchiveResult) | Error>) {
	const calls: ArchiveWebsiteOptions[] = [];
	let sampled = 0;
	const archiveWebsite = async (options: ArchiveWebsiteOptions): Promise<WebsiteArchiveResult> => {
		calls.push(options);
		if (options.egress !== "residential") return first();
		const next = samples[sampled++];
		if (!next) throw new Error("No further sample was scripted.");
		if (next instanceof Error) throw next;
		return next();
	};
	return { archiveWebsite, calls, sampleCalls: () => calls.filter((options) => options.egress === "residential") };
}

async function websiteOf(id: bigint) {
	const submission = (await SubmissionsEntity.get(id))!;
	if (submission.data.kind !== "website") throw new Error("Not a website case.");
	return { submission, website: submission.data.website };
}

async function reportTargets(id: bigint) {
	const reports = await AbuseRepository.listReportsForSubmission(id);
	return (await Promise.all(reports.map(async (report) => (await AbuseRepository.listTargets(report.id))[0]!.normalizedTarget))).sort();
}

describe("a link that rotates offers per click, sampled in one case", () => {
	test("a new offer is walked, judged and reported as its own route; visits that only repeat a route keep their hops; two repeats in a row end the sampling", async () => {
		const calls: ModelCall[] = [];
		const link = rotatingLink(() => productionVisit(), [() => cloudStorageVisit(), () => productionVisit(), () => cloudStorageVisit()]);
		const id = await websiteSubmission(383412636961738752n, LINK);
		await analyzeWebsite({ submissionId: id, url: LINK }, funnelDependencies(link.archiveWebsite, calls));

		const { submission, website } = await websiteOf(id);
		expect(submission.status).toBe("reported");
		// Each sampled visit from the residential exit, in a browser the first walk (Chrome on Windows) was not, then that one.
		expect(link.sampleCalls().map((options) => ({ egress: options.egress, ua: options.visitor?.override.userAgent.match(/Macintosh|iPhone|Windows/)?.[0], device: options.device, keepSession: options.keepSession }))).toEqual([
			{ egress: "residential", ua: "Macintosh", device: undefined, keepSession: true },
			{ egress: "residential", ua: undefined, device: "iphone", keepSession: true },
			{ egress: "residential", ua: undefined, device: undefined, keepSession: true },
		]);

		// Two routes: the funnel the first walk took, and the cloud-storage renewal the first sampled visit reached.
		expect(website.routes?.map((route) => route.hops.map(({ url }) => url))).toEqual([
			[LINK, PRODUCTION_URLS.everflowRedirect, PRODUCTION_URLS.voluumCampaign, PRODUCTION_URLS.lure, PRODUCTION_URLS.voluumClick, PRODUCTION_URLS.wrapper, PRODUCTION_URLS.cakeLink, PRODUCTION_URLS.cakeCookieCheck, PRODUCTION_URLS.checkout],
			[LINK, CLOUD_STORAGE_URLS.tracker, CLOUD_STORAGE_URLS.scam],
		]);
		expect(website.routes?.map((route) => route.visitor)).toEqual([{ browser: "Chrome on Windows", network: "residential exit" }, { browser: "Chrome on macOS", network: "residential exit" }]);
		// Each route judged by itself: the first a deceptive funnel with no phishing site, the second a payment-fraud page.
		expect(website.routes?.[0]?.funnel?.verdict.finding).toBe("deceptive_funnel");
		expect(website.routes?.[0]?.siteAssessments?.some(({ finding }) => finding === "phishing")).toBeFalse();
		expect(website.routes?.[1]?.siteAssessments?.find(({ hopIndex }) => hopIndex === 2)).toMatchObject({ finding: "phishing", phishingBasis: "payment_fraud", judgedHopIndex: 2 });
		// It passed the Everflow link too, but reached no merchant's offer: no funnel to ask the model about.
		expect(website.routes?.[1]?.funnel?.verdict.finding).toBe("insufficient_evidence");
		expect(website.routes?.[1]?.analyzedHopIndex).toBe(2);
		// The case's headline is the first route with a reportable site.
		expect(website.analyzedRoute).toBe(1);
		expect(website.archiveUrl).toBe(CLOUD_STORAGE_URLS.scam);

		// The visits that showed known routes again are kept as their hops; the sampling ended after two of them.
		expect(website.rotation?.visits.map((visit) => ({ browser: visit.visitor.browser, ...("route" in visit ? { route: visit.route } : {}), ...("repeatOf" in visit ? { repeatOf: visit.repeatOf, hops: visit.hops.map(({ hostname }) => hostname) } : {}) }))).toEqual([
			{ browser: "Chrome on macOS", route: 1 },
			{ browser: "Safari on iPhone", repeatOf: 0, hops: ["www.onlinesafetyall.com", "www.onlinesafetyall.com", "wtrck.com", "ultimateprizesearch.com"] },
			{ browser: "Chrome on Windows", repeatOf: 1, hops: ["www.onlinesafetyall.com", "safe.cloudforstorage.com", "cloudstore-nnn6.ric1.digitaloceanspaces.com"] },
		]);
		expect(website.rotation?.ended).toBe("2 visits in a row showed only routes seen before.");

		// The first route's files keep their names; the second route's are its own.
		const names = (await ArtifactsEntity.listForSubmission(id)).map((file) => file.name);
		for (const name of ["website.png", "website.mhtml", "website-step2.png", "chain-hop-3.html", "chain-hop-8.html", "evidence-manifest.json", "visit-record.json"]) expect(names).toContain(name);
		for (const name of ["route2-website.png", "route2-website.mhtml", "route2-website-stamped.png", "route2-evidence-manifest.json", "route2-chain-hop-2.html", "route2-visit-record.json", "route2-visit-manifest.json"]) expect(names).toContain(name);
		// A repeat is no route: it stored no capture.
		expect(names.filter((name) => name?.startsWith("route3-"))).toEqual([]);
		// No file of one route was stored under another's name, nor twice.
		expect(new Set(names).size).toBe(names.length);

		// Each route is reported for what it found: the funnel's businesses, and the renewal scam's host.
		expect(await reportTargets(id)).toEqual([
			"affiliate:merchant:-:zatos.com:15065",
			"affiliate:network:cake:miamitrk.com:15065",
			"affiliate:network:everflow:onlinesafetyall.com:6RNXHT",
			"cloudstore-nnn6.ric1.digitaloceanspaces.com",
		]);
		// Each route is named by the first site it reached after the link's own.
		expect(submission.info).toContain("Route 1 of 2, via wtrck.com: Deceptive affiliate funnel: affiliate 15065 is being reported to zatos.com (the merchant).");
		expect(submission.info).toContain(`Route 2 of 2, via safe.cloudforstorage.com: Phishing confirmed at ${CLOUD_STORAGE_URLS.scam}`);

		// Each page judged once, the funnel route once as a funnel, and one narrative over both routes' findings.
		expect(calls.map(({ kind }) => kind)).toEqual(["site", "site", "funnel", "site", "narrative"]);
		const narrative = calls.at(-1)!.input;
		expect(narrative).toContain("Route 1 of 2, via wtrck.com: Deceptive affiliate funnel");
		expect(narrative).toContain("Route 2 of 2, via safe.cloudforstorage.com:");
	});

	test("a link that passed no tracking link is not opened again", async () => {
		const calls: ModelCall[] = [];
		const kit = "https://kit-login.com/signin";
		const link = rotatingLink(() => capturedPage(kit, "<p>Sign in</p>", "Sign in", [funnelHop(0, "https://lure-page.com/a", 302, { redirectTo: kit }), funnelHop(1, kit, 200)], scriptedVisitSession()), [() => cloudStorageVisit()]);
		const id = await websiteSubmission(383412636961738753n, "https://lure-page.com/a");
		await analyzeWebsite({ submissionId: id, url: "https://lure-page.com/a" }, funnelDependencies(link.archiveWebsite, calls));

		const { website } = await websiteOf(id);
		expect(link.sampleCalls()).toEqual([]);
		expect(website.routes).toHaveLength(1);
		expect(website.rotation).toBeUndefined();
		expect(website.routes?.[0]?.funnel).toBeUndefined();
	});

	test("the residential exit failing ends the sampling at once, and the first walk's findings are reported as they are", async () => {
		const calls: ModelCall[] = [];
		const link = rotatingLink(() => productionVisit(), [new Error("Browser service unavailable: residential exit is offline")]);
		const id = await websiteSubmission(383412636961738754n, LINK);
		await analyzeWebsite({ submissionId: id, url: LINK }, funnelDependencies(link.archiveWebsite, calls));

		const { submission, website } = await websiteOf(id);
		expect(submission.status).toBe("reported");
		// Not retried: the residential exit is one connection, and the case does not wait it out.
		expect(link.sampleCalls()).toHaveLength(1);
		expect(website.rotation).toMatchObject({
			visits: [{ visitor: { browser: "Chrome on macOS", network: "residential exit" }, error: "Browser service unavailable: residential exit is offline" }],
			ended: "Opening the link again from the residential exit failed: Browser service unavailable: residential exit is offline",
		});
		expect(website.routes).toHaveLength(1);
		expect(website.analyzedRoute).toBeUndefined();
		expect(await reportTargets(id)).toEqual(["affiliate:merchant:-:zatos.com:15065", "affiliate:network:cake:miamitrk.com:15065", "affiliate:network:everflow:onlinesafetyall.com:6RNXHT"]);
		// A single route's info names no route.
		expect(submission.info).not.toContain("Route 1");
	});

	test("no visit starts once the sampling's time is used up", async () => {
		const calls: ModelCall[] = [];
		const link = rotatingLink(() => productionVisit(), [() => cloudStorageVisit()]);
		const id = await websiteSubmission(383412636961738755n, LINK);
		await analyzeWebsite({ submissionId: id, url: LINK }, { ...funnelDependencies(link.archiveWebsite, calls), rotationBudgetMs: 0 });

		const { website } = await websiteOf(id);
		expect(link.sampleCalls()).toEqual([]);
		expect(website.rotation).toEqual({ visits: [], ended: "The time for sampling the link's other offers (0 min) was used up." });
	});

	test("a sampled walk that has to be made again as a phone closes its browser first: the residential exit is one connection", async () => {
		const calls: ModelCall[] = [];
		const events: string[] = [];
		// The offer shows desktops only a hand-off to a phone, which is nothing by itself.
		const handoff = "https://mobile-only-offer.com/start";
		const desktop = () => {
			const visit = capturedPage(handoff, "<p>Continue on your phone</p>", "Continue on your phone", [funnelHop(0, LINK, 302, { redirectTo: CLOUD_STORAGE_URLS.tracker }), funnelHop(1, CLOUD_STORAGE_URLS.tracker, 302, { redirectTo: handoff }), funnelHop(2, handoff, 200)]);
			const session = scriptedVisitSession({ agent: { outcome: "completed", actions: [], report: { asksForPhone: true, blockedByChallenge: false, stoppedReason: "The page asks to continue on a phone." } } });
			return { ...visit, session: { ...session, close: async () => { events.push("desktop closed"); } } };
		};
		const link = rotatingLink(() => productionVisit(), [desktop, () => { events.push("phone opened"); return cloudStorageVisit(); }, () => productionVisit(), () => productionVisit()]);
		const id = await websiteSubmission(383412636961738757n, LINK);
		await analyzeWebsite({ submissionId: id, url: LINK }, funnelDependencies(link.archiveWebsite, calls));

		const { website } = await websiteOf(id);
		expect(events.slice(0, 2)).toEqual(["desktop closed", "phone opened"]);
		// The phone walk stayed on the residential exit, and the route it found is the case's.
		expect(link.sampleCalls().map(({ device }) => device)).toEqual([undefined, "iphone", "iphone", undefined]);
		expect(website.routes).toHaveLength(2);
		expect(website.routes?.[1]?.siteAssessments?.some(({ finding }) => finding === "phishing")).toBeTrue();
	});

	test("a sampled route whose walk breaks off ends the sampling; the routes walked before it are reported", async () => {
		const calls: ModelCall[] = [];
		const link = rotatingLink(() => productionVisit(), [() => ({ ...cloudStorageVisit(), session: { visit: async () => { throw new Error("the visit agent crashed"); }, close: async () => undefined } })]);
		const id = await websiteSubmission(383412636961738758n, LINK);
		await analyzeWebsite({ submissionId: id, url: LINK }, funnelDependencies(link.archiveWebsite, calls));

		const { submission, website } = await websiteOf(id);
		expect(submission.status).toBe("reported");
		expect(website.routes).toHaveLength(1);
		expect(website.rotation?.ended).toStartWith("Walking a new route failed:");
		expect(website.rotation?.visits).toMatchObject([{ visitor: { browser: "Chrome on macOS" }, error: expect.any(String) }]);
		expect(await reportTargets(id)).toEqual(["affiliate:merchant:-:zatos.com:15065", "affiliate:network:cake:miamitrk.com:15065", "affiliate:network:everflow:onlinesafetyall.com:6RNXHT"]);
	});

	test("two routes that each confirm a phishing site are both reported; the first is the headline", async () => {
		const calls: ModelCall[] = [];
		const link = rotatingLink(() => productionVisit(), [() => cloudStorageVisit(), () => productionVisit(), () => productionVisit()]);
		const id = await websiteSubmission(383412636961738759n, LINK);
		await analyzeWebsite({ submissionId: id, url: LINK }, funnelDependencies(link.archiveWebsite, calls, { phishingLure: true }));

		const { submission, website } = await websiteOf(id);
		expect(submission.status).toBe("reported");
		expect(website.analyzedRoute).toBeUndefined();
		expect(website.archiveUrl).toBe(PRODUCTION_URLS.lure);
		const targets = await reportTargets(id);
		expect(targets).toContain("ultimateprizesearch.com");
		expect(targets).toContain("cloudstore-nnn6.ric1.digitaloceanspaces.com");
	});

	test("the reporter's browser walks first; the sampled visits are the three others", async () => {
		const calls: ModelCall[] = [];
		const link = rotatingLink(() => productionVisit(), [() => productionVisit(), () => productionVisit()]);
		const id = await websiteSubmission(383412636961738756n, LINK);
		const reporterHeaders = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15" };
		await analyzeWebsite({ submissionId: id, url: LINK, reporterHeaders }, funnelDependencies(link.archiveWebsite, calls));

		const { website } = await websiteOf(id);
		expect(website.routes?.[0]?.visitor?.browser).toBe("The reporter's browser");
		// The first walk presented the reporter's Safari; the samples Chrome on Windows and on macOS, then stopped after two repeats.
		expect(link.calls[0]!.visitor?.override.userAgent).toBe(reporterHeaders["user-agent"]);
		expect(website.rotation?.visits.map(({ visitor }) => visitor.browser)).toEqual(["Chrome on Windows", "Chrome on macOS"]);
		expect(website.rotation?.ended).toBe("2 visits in a row showed only routes seen before.");
		expect(website.routes).toHaveLength(1);
	});
});

describe("sampling a rotating link's routes", () => {
	const first = firstWalkBrowser(undefined);
	const hops = (...urls: string[]) => urls.map((url, index) => navigationHop(index, url, index === urls.length - 1 ? { status: 200, contentCaptured: true } : { status: 302, redirectTo: urls[index + 1] }));
	const offer = (site: string) => hops(LINK, PRODUCTION_URLS.voluumCampaign, `https://${site}/landing`);
	const captureOf = (route: ReturnType<typeof hops>): WebsiteArchiveResult => ({ ...cloudStorageVisit(), navigationHops: route });

	test("a route is named by the first site past the link's trackers and the site of its first page", () => {
		expect(routeDestination(offer("smizeprize.com"), LINK)).toEqual({ via: "smizeprize.com", landing: "smizeprize.com" });
		// The cloud-storage tracker's UUID click path is a tracking link too: the route is told apart by the scam it reached.
		expect(routeDestination(cloudStorageVisit().navigationHops, LINK)).toEqual({ via: "cloudstore-nnn6.ric1.digitaloceanspaces.com", landing: "cloudstore-nnn6.ric1.digitaloceanspaces.com" });
		// Only the hops up to the first page count; where a walk went from there is no other route.
		expect(routeDestination([...productionVisit().navigationHops.slice(0, 4).map((hop, index) => (index === 3 ? { ...hop, contentCaptured: false, visitorStep: { submitted: [] } } : hop)), navigationHop(4, PRODUCTION_URLS.checkout, { contentCaptured: true })], LINK)).toEqual({ via: "ultimateprizesearch.com", landing: "ultimateprizesearch.com" });
		// A link that answered nothing reached no page.
		expect(routeDestination([navigationHop(0, LINK, { status: 302, redirectTo: "https://www.yahoo.com/" })], LINK)).toEqual({});
	});

	test("routes are named by the first site after the link, and told apart by their first page when they share it", () => {
		const site = websiteSite(LINK);
		expect(routeNames([productionVisit().navigationHops, cloudStorageVisit().navigationHops], site)).toEqual(["wtrck.com", "safe.cloudforstorage.com"]);
		// One tracker rotating two offers.
		expect(routeNames([offer("smizeprize.com"), offer("other-offer.com"), cloudStorageVisit().navigationHops], site)).toEqual(["wtrck.com to smizeprize.com", "wtrck.com to other-offer.com", "safe.cloudforstorage.com"]);
		// A route that never left the submitted site is named by it.
		expect(routeNames([[navigationHop(0, LINK, { status: 200, contentCaptured: true })]], site)).toEqual(["www.onlinesafetyall.com"]);
	});

	test("every browser but the first walk's, then the first walk's own", () => {
		expect(rotationBrowsers(first).map(({ label }) => label)).toEqual(["Chrome on macOS", "Safari on iPhone", "Chrome on Windows"]);
		const reporter: RotationBrowser = { label: "The reporter's browser" };
		expect(rotationBrowsers(reporter).map(({ label }) => label)).toEqual(["Chrome on Windows", "Chrome on macOS", "Safari on iPhone"]);
	});

	test("a visit that showed something new resets the count of repeats", async () => {
		const shown = [offer("smizeprize.com"), offer("cloud.example-scam.com"), offer("smizeprize.com")];
		const walked: number[] = [];
		const rotation = await sampleRotation({
			url: LINK,
			routes: [offer("smizeprize.com")],
			first,
			capture: async () => captureOf(shown.shift()!),
			walk: async (archive, _browser, route) => {
				walked.push(route);
				return archive.navigationHops;
			},
		});
		expect(rotation.visits.map((visit) => ("route" in visit ? `new ${visit.route}` : "repeatOf" in visit ? `repeat ${visit.repeatOf}` : "error"))).toEqual(["repeat 0", "new 1", "repeat 0"]);
		expect(walked).toEqual([1]);
		expect(rotation.ended).toBe("All 3 visits were made.");
	});

	test("the time budget is checked before every visit, never during one", async () => {
		let clock = 0;
		const rotation = await sampleRotation({
			url: LINK,
			routes: [offer("smizeprize.com")],
			first,
			budgetMs: 10_000,
			now: () => clock,
			capture: async () => {
				clock += 6_000;
				return captureOf(offer(`offer-${clock}.com`));
			},
			walk: async (archive) => archive.navigationHops,
		});
		expect(rotation.visits.map((visit) => ("route" in visit ? visit.route : undefined))).toEqual([1, 2]);
		expect(rotation.ended).toBe("The time for sampling the link's other offers (0 min) was used up.");
	});

	test("a walk that breaks off ends the sampling, and no later route takes its number", async () => {
		let captures = 0;
		const routes = [offer("smizeprize.com")];
		const rotation = await sampleRotation({
			url: LINK,
			routes,
			first,
			capture: async () => captureOf(offer(`offer-${++captures}.com`)),
			walk: async () => {
				throw new Error("the classifier timed out");
			},
		});
		expect(captures).toBe(1);
		expect(routes).toHaveLength(1);
		expect(rotation).toEqual({ visits: [{ startedAt: expect.any(String), visitor: { browser: "Chrome on macOS", network: "residential exit" }, error: "the classifier timed out" }], ended: "Walking a new route failed: the classifier timed out" });
	});

	test("a repeat's browser is closed, a new route's is left to its walk", async () => {
		const closed: string[] = [];
		const capture = (site: string) => ({ ...captureOf(offer(site)), session: { visit: async () => { throw new Error("not walked"); }, close: async () => { closed.push(site); } } });
		const sites = ["smizeprize.com", "new-offer.com", "smizeprize.com", "smizeprize.com"];
		await sampleRotation({ url: LINK, routes: [offer("smizeprize.com")], first, capture: async () => capture(sites.shift()!), walk: async (archive) => archive.navigationHops });
		expect(closed).toEqual(["smizeprize.com", "smizeprize.com"]);
	});
});
