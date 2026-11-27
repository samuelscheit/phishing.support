import { describe, expect, test } from "bun:test";

import { AbuseRepository } from "../../abuse/repository";
import { FUNNEL_EVIDENCE_NAME, readFunnelFacts } from "../../abuse/funnel/facts";
import { CHECKOUT_TEXT, LURE_TEXT, PRODUCTION_URLS } from "../../abuse/funnel/test_fixtures";
import { jobs } from "../../abuse/schema";
import { getDb } from "../../db";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { useTrackingTokenSecret } from "../../abuse/security/test_helpers";
import type { ScriptedPage } from "../../site_visit/test_helpers";
import { getReportsForSubmission } from "../../submissions/abuse_details";
import { websiteSubmission } from "../test_helpers";
import { analyzeWebsite } from "./ai";
import { CHECKOUT_HTML, LURE_HTML, START, capturedPage, funnelDependencies, funnelHop, productionVisit, type ModelCall } from "./funnel_test_helpers";
import { eq } from "drizzle-orm";

useTemporaryDatabase();
useTrackingTokenSecret();

/** Another link of the same campaign, handed out as the affiliate's own Voluum link: the same lure and checkout, no Everflow. */
function voluumVisit(): ScriptedPage {
	const u = PRODUCTION_URLS;
	const checkout = capturedPage(u.checkout, CHECKOUT_HTML, CHECKOUT_TEXT, [
		funnelHop(2, u.voluumClick, 302, { redirectTo: u.wrapper }),
		funnelHop(3, u.wrapper, 302, { redirectTo: u.cakeLink }),
		funnelHop(4, u.cakeLink, 302, { redirectTo: u.cakeCookieCheck }),
		funnelHop(5, u.cakeCookieCheck, 302, { redirectTo: u.checkout }),
		funnelHop(6, u.checkout, 200),
	]);
	return capturedPage(u.lure, LURE_HTML, LURE_TEXT, [funnelHop(0, u.voluumCampaign, 302, { redirectTo: u.lure }), funnelHop(1, u.lure, 200)], { steps: [checkout] });
}

/** The production funnel's boundaries, every capture of the case returning `capture()`. */
function dependencies(capture: () => ScriptedPage, calls: ModelCall[], options: { phishingLure?: boolean; popular?: string[] } = {}) {
	return funnelDependencies(async () => capture(), calls, options);
}

const PARTIES = [
	"affiliate:merchant:-:zatos.com:15065",
	"affiliate:network:everflow:onlinesafetyall.com:6RNXHT",
	"affiliate:network:cake:miamitrk.com:15065",
];

async function targetsOf(reportIds: bigint[]) {
	return Promise.all(reportIds.map(async (id) => (await AbuseRepository.listTargets(id))[0]!.normalizedTarget));
}

describe("a deceptive affiliate funnel, analyzed as one case", () => {
	test("the production chain: one case with every hop, page and body, judged a fake application, reported to the merchant and each network once per affiliate", async () => {
		const calls: ModelCall[] = [];
		const link = PRODUCTION_URLS.everflowLink;
		const id = await websiteSubmission(383000000000000001n, link);
		await analyzeWebsite({ submissionId: id, url: link }, dependencies(() => productionVisit(link), calls));

		// One case: the chain never became a second case.
		expect((await SubmissionsEntity.listCards({ limit: 10 })).map((card) => card.id)).toEqual([id]);
		const submission = (await SubmissionsEntity.get(id))!;
		expect(submission.status).toBe("reported");
		const website = submission.data.kind === "website" ? submission.data.website : undefined;
		const u = PRODUCTION_URLS;
		expect(website?.routes![0]!.hops?.map(({ index, url, status, redirectTo, receivedAt, bodyCaptured, contentCaptured }) => ({ index, url, status, redirectTo, receivedAt, bodyCaptured, contentCaptured }))).toEqual([
			{ index: 0, url: link, status: 302, redirectTo: u.everflowRedirect, receivedAt: "2026-11-23T09:14:02.000Z", bodyCaptured: undefined, contentCaptured: false },
			{ index: 1, url: u.everflowRedirect, status: 302, redirectTo: u.voluumCampaign, receivedAt: "2026-11-23T09:14:02.700Z", bodyCaptured: undefined, contentCaptured: false },
			{ index: 2, url: u.voluumCampaign, status: 302, redirectTo: u.lure, receivedAt: "2026-11-23T09:14:03.400Z", bodyCaptured: undefined, contentCaptured: false },
			{ index: 3, url: u.lure, status: 200, redirectTo: u.voluumClick, receivedAt: "2026-11-23T09:14:04.100Z", bodyCaptured: true, contentCaptured: false },
			{ index: 4, url: u.voluumClick, status: 302, redirectTo: u.wrapper, receivedAt: "2026-11-23T09:14:04.800Z", bodyCaptured: undefined, contentCaptured: false },
			{ index: 5, url: u.wrapper, status: 302, redirectTo: u.cakeLink, receivedAt: "2026-11-23T09:14:05.500Z", bodyCaptured: undefined, contentCaptured: false },
			{ index: 6, url: u.cakeLink, status: 302, redirectTo: u.cakeCookieCheck, receivedAt: "2026-11-23T09:14:06.200Z", bodyCaptured: undefined, contentCaptured: false },
			{ index: 7, url: u.cakeCookieCheck, status: 302, redirectTo: u.checkout, receivedAt: "2026-11-23T09:14:06.900Z", bodyCaptured: undefined, contentCaptured: false },
			{ index: 8, url: u.checkout, status: 200, redirectTo: undefined, receivedAt: "2026-11-23T09:14:07.600Z", bodyCaptured: true, contentCaptured: true },
		]);
		// Both pages and both bodies are the case's evidence.
		const files = await ArtifactsEntity.listForSubmission(id);
		for (const name of ["website.png", "website.mhtml", "website-step2.png", "website-step2.mhtml", "chain-hop-3.html", "chain-hop-8.html"]) expect(files.map((file) => file.name)).toContain(name);
		const body = async (name: string) => Buffer.from((await ArtifactsEntity.get(files.find((file) => file.name === name)!.id))!.blob).toString("utf8");
		expect(await body("chain-hop-3.html")).toBe(LURE_HTML);
		expect(await body("chain-hop-8.html")).toBe(CHECKOUT_HTML);

		// Each page judged for its site (nothing phishing), the chain once as a funnel, with every page shown and the tracking links.
		expect(calls.map(({ kind }) => kind)).toEqual(["site", "site", "funnel", "narrative"]);
		const funnelInput = calls.find(({ kind }) => kind === "funnel")!.input;
		for (const expected of ["page-3", "page-8", "Complete the final step", "$19.98/month", "miamitrk.com", "CAKE"]) expect(funnelInput).toContain(expected);
		expect(calls.at(-1)!.input).toContain("Deceptive affiliate funnel: the chain's lure is a fake application for money or benefits.");
		expect(calls.at(-1)!.input).toContain(u.checkout);

		expect(website?.routes![0]!.funnel?.verdict).toMatchObject({ finding: "deceptive_funnel", deceptionKind: "fake_application", offerQuote: { hopIndex: 8, quote: "$19.98/month" } });
		expect(website?.routes![0]!.funnel?.extraction.merchant?.site).toBe("zatos.com");
		expect(website?.routes![0]!.funnel?.extraction.parties.map(({ role, site, affiliateIds }) => ({ role, site, affiliateIds }))).toEqual([
			{ role: "merchant", site: "zatos.com", affiliateIds: ["15065"] },
			{ role: "network", site: "onlinesafetyall.com", affiliateIds: ["6RNXHT"] },
			{ role: "network", site: "miamitrk.com", affiliateIds: ["15065"] },
		]);

		// The merchant and each network get their report, mailed by the worker: no phishing report of any site.
		const reports = await AbuseRepository.listReportsForSubmission(id);
		expect(await targetsOf(reports.map(({ id: reportId }) => reportId))).toEqual(PARTIES);
		expect(reports.map(({ allegationCategory }) => allegationCategory)).toEqual(["fraud", "fraud", "fraud"]);
		const zatos = await AbuseRepository.getReportInput(reports[0]!.id);
		const facts = readFunnelFacts(zatos!.evidenceArtifacts.map(({ name, blob }) => ({ filename: name, content: Buffer.from(blob) })))!;
		expect(facts.party).toMatchObject({ role: "merchant", site: "zatos.com", affiliateId: "15065" });
		expect(facts.chain.map(({ index, at }) => [index, at])).toEqual(website!.routes![0]!.hops!.map(({ index, receivedAt }) => [index, receivedAt]));
		expect(facts.screenshots.map(({ filename }) => filename)).toEqual(["lure-page-3.png", "offer-page-8.png"]);
		expect(zatos!.evidenceArtifacts.map(({ name }) => name)).toEqual([FUNNEL_EVIDENCE_NAME, "lure-page-3.png", "offer-page-8.png"]);
		expect(submission.info).toBe([
			"Deceptive affiliate funnel: affiliate 15065 is being reported to zatos.com (the merchant).",
			"Deceptive affiliate funnel: affiliate 6RNXHT is being reported to onlinesafetyall.com (affiliate network).",
			"Deceptive affiliate funnel: affiliate 15065 is being reported to miamitrk.com (affiliate network).",
		].join("\n"));

		// A replayed analysis of the case, which sees the chain anew, files nothing new.
		await analyzeWebsite({ submissionId: id, url: link }, dependencies(() => ({ ...productionVisit(), archivedAt: new Date(START + 60_000) }), []));
		expect((await AbuseRepository.listReportsForSubmission(id)).map(({ id: reportId }) => reportId)).toEqual(reports.map(({ id: reportId }) => reportId));

		// The affiliate's own Voluum link is another case, which joins the open reports of the merchant and CAKE instead of mailing again.
		const second = u.voluumCampaign;
		const secondId = await websiteSubmission(383000000000000002n, second);
		expect(secondId).not.toBe(id);
		await analyzeWebsite({ submissionId: secondId, url: second }, dependencies(voluumVisit, []));
		const joined = (await SubmissionsEntity.get(secondId))!;
		expect(joined.status).toBe("reported");
		// Walked once: the lure the visitor clicked through, back via the tracker it was sent from, is no cloaked answer.
		expect(joined.data.kind === "website" && joined.data.website.routes![0]!.hops?.map(({ url }) => url)).toEqual([u.voluumCampaign, u.lure, u.voluumClick, u.wrapper, u.cakeLink, u.cakeCookieCheck, u.checkout]);
		expect(joined.info).toBe([
			`Deceptive affiliate funnel: affiliate 15065 at zatos.com (the merchant) is already being reported in case ${id.toString()}, whose report now names this case too.`,
			`Deceptive affiliate funnel: affiliate 15065 at miamitrk.com (affiliate network) is already being reported in case ${id.toString()}, whose report now names this case too.`,
		].join("\n"));
		expect(await AbuseRepository.listReportsForSubmission(secondId)).toEqual([]);
		const shown = await getReportsForSubmission(secondId);
		const [merchant, , cake] = reports;
		expect(shown.map(({ id: reportId, submissionId, joinedCases }) => ({ reportId, submissionId, joinedCases }))).toEqual([merchant!, cake!].map(({ id: reportId }) => ({ reportId, submissionId: id, joinedCases: [secondId] })));
		expect(shown.map(({ funnelParty }) => funnelParty)).toEqual([
			{ role: "merchant", site: "zatos.com", affiliateId: "15065" },
			{ role: "network", site: "miamitrk.com", platform: "cake", affiliateId: "15065" },
		]);
		// Nothing more for the worker to resolve or mail.
		const resolveJobs = (await getDb()).select().from(jobs).where(eq(jobs.jobType, "resolve_report")).all();
		expect(resolveJobs.map(({ reportId }) => reportId)).toEqual(reports.map(({ id: reportId }) => reportId));
	});

	test("a lure that is a phishing page itself is reported as such, and the funnel it feeds to each business beside it", async () => {
		const link = PRODUCTION_URLS.everflowLink;
		const id = await websiteSubmission(383000000000000005n, link);
		await analyzeWebsite({ submissionId: id, url: link }, dependencies(() => productionVisit(link), [], { phishingLure: true }));
		const submission = (await SubmissionsEntity.get(id))!;
		expect(submission.status).toBe("reported");
		const reports = await AbuseRepository.listReportsForSubmission(id);
		expect(await targetsOf(reports.map(({ id: reportId }) => reportId))).toEqual(["ultimateprizesearch.com", ...PARTIES]);
		expect(reports.map(({ allegationCategory }) => allegationCategory)).toEqual(["phishing", "fraud", "fraud", "fraud"]);
		expect(submission.info?.split("\n")).toEqual([
			`Phishing confirmed at ${PRODUCTION_URLS.lure}; its evidence is being collected before the report is sent.`,
			"Deceptive affiliate funnel: affiliate 15065 is being reported to zatos.com (the merchant).",
			"Deceptive affiliate funnel: affiliate 6RNXHT is being reported to onlinesafetyall.com (affiliate network).",
			"Deceptive affiliate funnel: affiliate 15065 is being reported to miamitrk.com (affiliate network).",
		]);
		const website = submission.data.kind === "website" ? submission.data.website : undefined;
		expect(website?.routes![0]!.analyzedHopIndex).toBe(3);
		expect(website?.routes![0]!.funnel?.verdict.finding).toBe("deceptive_funnel");
	});

	test("a deceptive funnel whose every business is left out is said, and nothing is reported", async () => {
		// The affiliate's own tracker straight to a well-known merchant that no network credits: nobody to report it to.
		const u = PRODUCTION_URLS;
		const capture = () => capturedPage(u.lure, LURE_HTML, LURE_TEXT, [funnelHop(0, u.voluumCampaign, 302, { redirectTo: u.lure }), funnelHop(1, u.lure, 200)], {
			steps: [capturedPage(u.checkout, CHECKOUT_HTML, CHECKOUT_TEXT, [funnelHop(2, u.voluumClick, 302, { redirectTo: u.checkout }), funnelHop(3, u.checkout, 200)])],
		});
		const id = await websiteSubmission(383000000000000006n, u.voluumCampaign);
		await analyzeWebsite({ submissionId: id, url: u.voluumCampaign }, dependencies(capture, [], { popular: ["zatos.com"] }));
		const submission = (await SubmissionsEntity.get(id))!;
		expect(submission.status).toBe("invalid");
		expect(submission.info).toContain("Deceptive affiliate funnel: the chain's lure is a fake application for money or benefits.");
		expect(submission.info).toContain("Deceptive affiliate funnel: zatos.com (the merchant) is not reported, being a well-known site (Tranco top list) that no network passed its affiliate ID on to.");
		expect(submission.info).toEndWith("No report was created.");
		expect(submission.data.kind === "website" && submission.data.website.routes![0]!.funnel?.skipped).toEqual([{ site: "zatos.com", role: "merchant", reason: "a well-known site (Tranco top list) that no network passed its affiliate ID on to" }]);
		expect(await AbuseRepository.listReportsForSubmission(id)).toEqual([]);
	});

	test("a coupon blog that names the store it sends visitors to is no deceptive funnel: judged, kept, never reported", async () => {
		const blog = "https://www.dealsdiaryblog.com/zappos-coupon";
		const tune = "https://dealsnet.go2cloud.org/aff_c?offer_id=812&aff_id=4471";
		const store = "https://www.zappos.com/running-shoes";
		const storeText = "Zappos\nRunning Shoes\n$89.95\nAdd to Cart";
		const blogText = "Zappos coupon: 20% off running shoes\nShop the sale at Zappos";
		const storeHtml = `<html><head><title>Zappos</title></head><body><p>${storeText}</p></body></html>`;
		const capture = () => capturedPage(blog, `<html><body><p>${blogText}</p></body></html>`, blogText, [funnelHop(0, blog, 200)], {
			steps: [capturedPage(store, storeHtml, storeText, [funnelHop(1, tune, 302, { redirectTo: store }), funnelHop(2, store, 200)])],
		});
		const calls: ModelCall[] = [];
		const id = await websiteSubmission(383000000000000003n, blog);
		await analyzeWebsite({ submissionId: id, url: blog }, dependencies(capture, calls));

		const submission = (await SubmissionsEntity.get(id))!;
		expect(submission.status).toBe("invalid");
		expect(calls.map(({ kind }) => kind)).toEqual(["site", "site", "funnel", "narrative"]);
		const website = submission.data.kind === "website" ? submission.data.website : undefined;
		expect(website?.routes![0]!.funnel?.verdict).toEqual({ finding: "not_deceptive" });
		expect(website?.routes![0]!.funnel?.extraction.merchant?.site).toBe("zappos.com");
		expect(await AbuseRepository.listReportsForSubmission(id)).toEqual([]);
		expect(await AbuseRepository.listJoinedReportsForSubmission(id)).toEqual([]);
	});

	test("a chain through no tracking link is no funnel: the model is not asked and nothing is kept", async () => {
		const blog = "https://www.dealsdiaryblog.com/plain";
		const store = "https://www.zappos.com/sale";
		const capture = () => capturedPage(blog, "<html><body>Sale</body></html>", "Sale", [funnelHop(0, blog, 200)], { steps: [capturedPage(store, "<html><body>Zappos sale</body></html>", "Zappos sale", [funnelHop(1, store, 200)])] });
		const calls: ModelCall[] = [];
		const id = await websiteSubmission(383000000000000004n, blog);
		await analyzeWebsite({ submissionId: id, url: blog }, dependencies(capture, calls));
		const submission = (await SubmissionsEntity.get(id))!;
		expect(calls.map(({ kind }) => kind)).toEqual(["site", "site", "narrative"]);
		expect(submission.data.kind === "website" && submission.data.website.routes![0]!.funnel).toBeUndefined();
	});
});
