import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../../db/entities/submissions";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { createAbuseEmailDraft } from "../mail/draft";
import { AbuseRepository } from "../repository";
import { resolveAbuseTarget } from "../resolver";
import { AbuseWorker } from "../worker";
import { sendEmail } from "../worker/email";
import { routeToNextContact } from "../worker/mail";
import { validateDeceptiveFunnelClassification, type DeceptiveFunnelFinding } from "./classification";
import { createFunnelEmailDraft } from "./draft";
import { extractFunnel } from "./extract";
import { FUNNEL_EVIDENCE_NAME, readFunnelFacts } from "./facts";
import { planFunnelReports, reportDeceptiveFunnel, type FunnelReportInput } from "./report";
import { chainOf, CHECKOUT_TEXT, LURE_TEXT, PRODUCTION_URLS, productionChain, rdapDomain, web, ZATOS_HOME } from "./test_fixtures";
import { DAY_MS } from "../../util/date_time";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { abuseReports } from "../schema";
import { RESOLUTION_LOOKUP_RETRIES, resolveReport, IncompleteResolutionError } from "../worker/resolution";
import { FUNNEL_REPORT_WINDOW_DAYS } from "./dedupe";

useTemporaryDatabase();

const environment = { SMTP_FROM: process.env.SMTP_FROM, REPLY_DOMAIN: process.env.REPLY_DOMAIN, ABUSE_TRACKING_TOKEN_SECRET: process.env.ABUSE_TRACKING_TOKEN_SECRET };
beforeEach(() => {
	process.env.SMTP_FROM = "support@phishing.support";
	process.env.REPLY_DOMAIN = "phishing.support";
	process.env.ABUSE_TRACKING_TOKEN_SECRET = "01234567890123456789012345678901";
});
afterAll(() => {
	for (const [name, value] of Object.entries(environment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const chain = productionChain();
const extraction = extractFunnel(chain);
const verdict = validateDeceptiveFunnelClassification({
	finding: "deceptive_funnel",
	deceptionKind: "fake_application",
	lureClaim: "The visitor's application for financial assistance was pre-approved and needed one final step.",
	reality: "A $19.98 per month Zatos Antivirus subscription checkout.",
	lureQuotes: [{ pageRef: "page-3", quote: "Your Financial Assist\nComplete the final step to submit your application." }],
	offerQuote: { pageRef: "page-8", quote: "$19.98/month" },
}, chain, extraction) as DeceptiveFunnelFinding;

const noPopular: ReadonlySet<string> = new Set();
const plan = (over: Partial<FunnelReportInput> = {}, popularDomains: ReadonlySet<string> = noPopular) => planFunnelReports({ submissionId: 42n, chain, extraction, verdict, ...over, popularDomains });

/** A chain of `urls` whose page 0 is the lure and whose last page the checkout, judged as the production chain was. */
function funnelOf(urls: string[]) {
	const custom = chainOf(urls, { 0: LURE_TEXT, [urls.length - 1]: CHECKOUT_TEXT });
	const customExtraction = extractFunnel(custom);
	const customVerdict = validateDeceptiveFunnelClassification({
		finding: "deceptive_funnel",
		deceptionKind: "fake_application",
		lureClaim: "The visitor's application was pre-approved.",
		reality: "A paid antivirus subscription.",
		lureQuotes: [{ pageRef: "page-0", quote: "Complete the final step to submit your application." }],
		offerQuote: { pageRef: `page-${urls.length - 1}`, quote: "$19.98/month" },
	}, custom, customExtraction) as DeceptiveFunnelFinding;
	expect(customVerdict.finding).toBe("deceptive_funnel");
	return { chain: custom, extraction: customExtraction, verdict: customVerdict };
}

function draftOf(input: Partial<FunnelReportInput>, index: number, route: { providerDisplayName: string; resolverProvenance: Record<string, unknown>; resolutionSnapshot: Record<string, unknown> }) {
	const { request } = plan(input).planned[index]!;
	return createFunnelEmailDraft({
		report: { id: 7n, submissionId: 42n },
		target: { normalizedTarget: request.targets[0]!.normalizedTarget, observedUrls: request.targets[0]!.observedUrls },
		route,
		evidence: request.evidence.map(({ filename, mimeType, buffer }) => ({ filename, mimeType, content: buffer })),
		attachmentNames: request.evidence.map(({ filename }) => filename),
	})!;
}

const websiteRoute = (site: string) => ({ providerDisplayName: site, resolverProvenance: { email: `info@${site}`, source: "funnel_website", foundAt: `https://${site}/` }, resolutionSnapshot: {} });

describe("planFunnelReports", () => {
	test("one report per business: the merchant and each network, each targeting the affiliate there", () => {
		const { planned, skipped } = plan();
		expect(skipped).toEqual([]);
		expect(planned.map(({ request }) => request.targets[0]!.normalizedTarget)).toEqual([
			"affiliate:merchant:-:zatos.com:15065",
			"affiliate:network:everflow:onlinesafetyall.com:6RNXHT",
			"affiliate:network:cake:miamitrk.com:15065",
		]);
		for (const { request, subject } of planned) {
			expect(request).toMatchObject({ allegationCategory: "fraud", targets: [{ targetType: "service_account" }] });
			expect(request.idempotencyKey).toBe(`${subject.key}:42`);
			expect(subject).toEqual({ key: expect.stringMatching(/^funnel:[0-9a-f]{32}$/), windowMs: FUNNEL_REPORT_WINDOW_DAYS * DAY_MS });
			expect(request.evidence.map(({ filename, mimeType }) => [filename, mimeType])).toEqual([
				[FUNNEL_EVIDENCE_NAME, "application/json"],
				["lure-page-3.png", "image/png"],
				["offer-page-8.png", "image/png"],
			]);
			expect(request.targets[0]!.observedUrls).toEqual(expect.arrayContaining([PRODUCTION_URLS.everflowLink, PRODUCTION_URLS.wrapper, PRODUCTION_URLS.cakeLink, PRODUCTION_URLS.checkout]));
			expect(request.description.split(/\s+/).length).toBeLessThan(30);
		}
		expect(planned[0]!.request.description).toBe("Deceptive affiliate funnel into zatos.com: Affiliate 15065 sent visitors to the offer from what we assess as a fake application for money or benefits.");
		expect(planned[2]!.request.description).toBe("Deceptive affiliate funnel through miamitrk.com (CAKE): Affiliate 15065 sent visitors from what we assess as a fake application for money or benefits to zatos.com.");
	});

	test("the facts file holds the whole chain, every tracker and the verbatim quotes", () => {
		const [merchant] = plan().planned;
		const facts = readFunnelFacts(merchant!.request.evidence.map(({ filename, buffer }) => ({ filename, content: buffer })))!;
		expect(facts.party).toEqual({ role: "merchant", site: "zatos.com", affiliateId: "15065" });
		expect(facts.networks).toEqual([
			{ site: "onlinesafetyall.com", platform: "everflow", platformConfidence: "high", affiliateId: "6RNXHT" },
			{ site: "miamitrk.com", platform: "cake", platformConfidence: "high", affiliateId: "15065" },
		]);
		expect(facts.chain).toHaveLength(9);
		expect(facts.chain[5]).toEqual({ index: 5, at: "2026-11-23T09:14:05.500Z", status: 302, url: PRODUCTION_URLS.wrapper, redirectTo: PRODUCTION_URLS.cakeLink, kind: "redirector" });
		expect(facts.trackers.map(({ platform }) => platform)).toEqual(["everflow", "everflow", "voluum", "voluum", "cake", "cake"]);
		expect(facts.deception.lureQuotes).toEqual([{ hopIndex: 3, url: PRODUCTION_URLS.lure, capturedAt: "2026-11-23T09:14:04.400Z", quote: "Your Financial Assist … Complete the final step to submit your application." }]);
		expect(facts.deception.offerQuote).toMatchObject({ hopIndex: 8, quote: "$19.98/month" });
		expect(facts.screenshots.map(({ filename }) => filename)).toEqual(["lure-page-3.png", "offer-page-8.png"]);
	});

	test("a lure or offer quote that is no longer verbatim page text means no report", () => {
		const changedLure = { ...chain, pages: chain.pages.map((page) => page.hopIndex === 3 ? { ...page, text: "A different page" } : page) };
		expect(() => plan({ chain: changedLure })).toThrow("verbatim");
		const changedOffer = { ...chain, pages: chain.pages.map((page) => page.hopIndex === 8 ? { ...page, text: "Sold out" } : page) };
		expect(() => plan({ chain: changedOffer })).toThrow("verbatim");
	});

	test("a verdict whose verbatim lure quotes are all too short to state a claim makes no report", () => {
		const buttonOnly = { ...verdict, lureQuotes: [{ hopIndex: 3, url: PRODUCTION_URLS.lure, quote: "CONTINUE" }] };
		expect(() => plan({ verdict: buttonOnly })).toThrow("substantial lure quote");
	});

	test("screenshots over the evidence limits are left out", () => {
		const heavy = { ...chain, pages: chain.pages.map((page) => page.hopIndex === 3 ? { ...page, screenshot: { buffer: Buffer.alloc(6 * 1024 * 1024), mimeType: "image/png" as const } } : page) };
		expect(plan({ chain: heavy }).planned[0]!.request.evidence.map(({ filename }) => filename)).toEqual([FUNNEL_EVIDENCE_NAME, "offer-page-8.png"]);
	});

	test("a well-known merchant is reported only when the network passed its affiliate ID on to it", () => {
		expect(plan({}, new Set(["zatos.com"])).skipped).toEqual([]);
		const costco = funnelOf(["https://lure.example/a", "https://miamitrk.com/?a=777&c=1&ckmxid=q", "https://www.costco.com/checkout?affid=XYZ1"]);
		const result = plan(costco, new Set(["costco.com"]));
		expect(result.skipped).toEqual([{ site: "costco.com", role: "merchant", reason: "a well-known site (Tranco top list) that no network passed its affiliate ID on to" }]);
		expect(result.planned.map(({ party }) => party.site)).toEqual(["miamitrk.com"]);
	});

	test("a well-known network domain is reported only when its link format leaves no doubt", () => {
		// TUNE's click path with only an affiliate and no offer is its format, not proof of it.
		const medium = funnelOf(["https://lure.example/a", "https://go.bigsite.com/aff_c?aff_id=7777", "https://shopfixture.com/x?affid=7777"]);
		expect(plan(medium, new Set(["bigsite.com"])).skipped).toEqual([{ site: "bigsite.com", role: "network", reason: "a well-known site (Tranco top list) whose links only resemble a tracking platform's" }]);
		const high = funnelOf(["https://lure.example/a", "https://go.bigsite.com/aff_c?aff_id=7777&offer_id=1", "https://shopfixture.com/x?affid=7777"]);
		expect(plan(high, new Set(["bigsite.com"])).skipped).toEqual([]);
	});

	test("a platform guessed from the link format stays out of the target, so no vendor is asked, and the mail says so", () => {
		const medium = funnelOf(["https://lure.example/a", "https://go2cloudfixture.com/aff_c?aff_id=15065", "https://shopfixture.com/x?affid=15065"]);
		const { planned } = plan(medium);
		expect(planned.map(({ request }) => request.targets[0]!.normalizedTarget)).toEqual(["affiliate:merchant:-:shopfixture.com:15065", "affiliate:network:-:go2cloudfixture.com:15065"]);
		expect(planned[1]!.request.description).toContain("through go2cloudfixture.com (a link in TUNE (HasOffers)'s format)");
		const draft = draftOf(medium, 1, websiteRoute("go2cloudfixture.com"));
		expect(draft.subject).toEndWith("Affiliate 15065 on go2cloudfixture.com sends deceptive traffic to shopfixture.com");
		expect(draft.body).toContain("is reporting affiliate 15065 on go2cloudfixture.com (a link in TUNE (HasOffers)'s format)");
		expect(draft.body).toContain("- go2cloudfixture.com: a link in TUNE (HasOffers)'s format (affiliate network or program)");
		expect(draft.body).toContain("[tracking link in TUNE (HasOffers)'s format]");
		expect(draft.body).not.toContain("TUNE (HasOffers) tracking");
	});

	test("a merchant without its own affiliate ID hears which ID the network credits, and its target names none", () => {
		const credited = funnelOf(["https://lure.example/a", "https://miamitrk.com/?a=15065&c=1&ckmxid=q", "https://shopfixture.com/product?pid=4471"]);
		const [merchant] = plan(credited).planned;
		expect(merchant!.request.targets[0]!.normalizedTarget).toBe("affiliate:merchant:-:shopfixture.com:-");
		expect(merchant!.request.description).toBe("Deceptive affiliate funnel into shopfixture.com: The affiliate miamitrk.com credits as 15065 sent visitors to the offer from what we assess as a fake application for money or benefits.");
		const draft = draftOf(credited, 0, websiteRoute("shopfixture.com"));
		expect(draft.subject).toEndWith("Affiliate credited as 15065 by miamitrk.com sends deceptive traffic to shopfixture.com");
		expect(draft.body).toContain("is reporting the affiliate that miamitrk.com (CAKE) credits as 15065, which sends visitors to your offer on shopfixture.com");
		expect(draft.body).toContain("- terminate the affiliate that miamitrk.com (CAKE) credits as 15065 in your affiliate program");
		expect(draft.body).toContain("- tell the network that delivered the traffic (miamitrk.com) that you terminated the affiliate;");
		expect(draft.body).not.toMatch(/Affiliate 4471|affiliate 4471/);
	});
});

describe("createFunnelEmailDraft", () => {
	const route = { providerDisplayName: "zatos.com", resolverProvenance: { email: "support@zatos.com", source: "funnel_website", foundAt: "https://help.zatos.com/terms/index-antivirus.php" }, resolutionSnapshot: {} };

	test("leaves every other report to the generic draft", () => {
		expect(createFunnelEmailDraft({ report: { id: 1n, submissionId: 2n }, target: { normalizedTarget: "telegram-bot:1", observedUrls: [] }, route })).toBeUndefined();
	});

	test("refuses to draft a funnel report whose facts are missing or corrupted", () => {
		const target = { normalizedTarget: "affiliate:merchant:-:zatos.com:15065", observedUrls: [] };
		expect(() => createFunnelEmailDraft({ report: { id: 1n, submissionId: 2n }, target, route })).toThrow(FUNNEL_EVIDENCE_NAME);
		expect(() => createFunnelEmailDraft({ report: { id: 1n, submissionId: 2n }, target, route, evidence: [{ filename: FUNNEL_EVIDENCE_NAME, mimeType: "application/json", content: Buffer.from("{\"kind\":\"deceptive_funnel\"}") }] })).toThrow(FUNNEL_EVIDENCE_NAME);
	});

	test("prints only the URLs the report recorded; any other by its host", () => {
		const [{ request }] = plan().planned as [ReturnType<typeof plan>["planned"][number]];
		const evidence = request.evidence.map(({ filename, mimeType, buffer }) => ({ filename, mimeType, content: buffer }));
		const draft = createFunnelEmailDraft({ report: { id: 1n, submissionId: 42n }, target: { normalizedTarget: request.targets[0]!.normalizedTarget, observedUrls: [PRODUCTION_URLS.checkout] }, route, evidence })!;
		expect(draft.body).toContain(PRODUCTION_URLS.checkout);
		expect(draft.body).not.toContain(PRODUCTION_URLS.everflowLink);
		expect(draft.body).toContain(`www.onlinesafetyall.com (full URL in ${FUNNEL_EVIDENCE_NAME})`);
		expect(draft.body).toContain("We are writing to the contact help.zatos.com publishes.");
	});

	test("a neutral greeting, the deception as our assessment, no promise of refunds, and no network to tell when there is none", () => {
		const merchantOnly = funnelOf(["https://lure.example/a", "https://t.example/click/1?cep=abc", "https://shopfixture.com/x?affid=AB12"]);
		const draft = draftOf(merchantOnly, 0, websiteRoute("shopfixture.com"));
		expect(draft.body).toStartWith("Hello shopfixture.com team,\n");
		expect(draft.body).toContain("showed what we assess as a fake application for money or benefits; from there the visit continued through affiliate tracking links to your offer.");
		expect(draft.body).toContain("- Our assessment of the lure: The visitor's application was pre-approved.");
		expect(draft.body).not.toMatch(/refund|tell the network|its button/);
	});

	test("an overlong chain is shortened, never the request or the sign-off", () => {
		const long = Array.from({ length: 45 }, (_, index) => `https://hop${index}.example/r?state=${"x".repeat(600)}`);
		const urls = ["https://lure.example/a", ...long, "https://miamitrk.com/?a=15065&c=1&ckmxid=q", "https://shopfixture.com/x?affid=15065"];
		const draft = draftOf(funnelOf(urls), 0, websiteRoute("shopfixture.com"));
		expect(draft.body.length).toBeLessThanOrEqual(20_000);
		expect(draft.body).toMatch(/\(\d+ more hops in funnel-evidence\.json\)/);
		expect(draft.body).toContain("We ask you to:");
		expect(draft.body).toEndWith("Regards,\nThe phishing.support team");
	});
});

const deps = web({
	"https://zatos.com/": { status: 301, location: "https://www.zatos.com/" },
	"https://www.zatos.com/": { body: ZATOS_HOME },
	"https://help.zatos.com/terms/index-antivirus.php": { body: "<p>Questions? Email <a href=\"mailto:support@zatos.com\">support@zatos.com</a></p>" },
	"https://rdap.test/domain/zatos.com": rdapDomain("zatos.com", { email: "c5@withheldforprivacy.com", org: "Privacy service provided by Withheld for Privacy ehf" }),
	"https://onlinesafetyall.com/": { body: "<title>Performance Marketing Platform</title><h1>Performance Tracking</h1>" },
	"https://miamitrk.com/": { body: "<html></html>" },
	"https://rdap.test/domain/miamitrk.com": rdapDomain("miamitrk.com", { email: "c1@withheldforprivacy.com", name: "Redacted for Privacy Purposes" }),
});

let caseCount = 0;
async function newCase(): Promise<bigint> {
	const url = `${PRODUCTION_URLS.everflowLink}&case=${++caseCount}`;
	return SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url } }, dedupeKey: `website-${url}` });
}

const report = (submissionId: bigint, dependencies: Parameters<typeof reportDeceptiveFunnel>[1] = {}) =>
	reportDeceptiveFunnel({ submissionId, chain, extraction, verdict, reporter: {} }, { loadPopularDomains: async () => noPopular, ...dependencies });

async function sent(routeId: bigint) {
	let mail: { to: string; subject: string; body: string; attachments: string[] } | undefined;
	const unknown: string[] = [];
	await sendEmail(routeId, {
		markUnknownExternal: async ({ error }) => {
			unknown.push(error);
		},
		createDraft: (input) => createAbuseEmailDraft(input, { generateSummary: async () => { throw new Error("a funnel mail needs no summary"); } }),
		send: async (params) => {
			mail = { to: params.recipient, subject: params.subject, body: params.body, attachments: (params.attachments ?? []).map(({ filename }) => filename) };
			return { messageId: 1n, status: "sent", rfcMessageId: "<funnel@phishing.support>" };
		},
	});
	expect(unknown).toEqual([]);
	return mail!;
}

describe("reportDeceptiveFunnel through the worker", () => {
	test("creates the reports, resolves each recipient without an operator, and mails the merchant and the networks", async () => {
		const submissionId = await newCase();
		const outcomes = await report(submissionId);
		expect(outcomes.map(({ kind, site }) => [kind, site])).toEqual([["reported", "zatos.com"], ["reported", "onlinesafetyall.com"], ["reported", "miamitrk.com"]]);
		const reportIds = outcomes.map((outcome) => outcome.kind === "reported" ? outcome.reportId : 0n);
		// Created again by a replayed analysis of the same case: the same reports, nothing linked.
		expect((await report(submissionId)).map((outcome) => outcome.kind === "reported" && !outcome.created && outcome.reportId)).toEqual(reportIds);

		const worker = new AbuseWorker({ owner: "funnel-test", resolveTarget: (target) => resolveAbuseTarget(target, deps) });
		for (let index = 0; index < 3; index++) expect(await worker.processOne({ jobTypes: ["resolve_report"] })).toBeTrue();
		const routes = await Promise.all(reportIds.map(async (reportId) => (await AbuseRepository.listRoutes(reportId))[0]!));
		expect(routes.map(({ routeType, status, verifiedEmail, providerDisplayName }) => [routeType, status, verifiedEmail, providerDisplayName])).toEqual([
			["email", "verified", "support@zatos.com", "zatos.com"],
			["email", "verified", "support@everflow.io", "Everflow"],
			["email", "verified", "info@getcake.com", "CAKE"],
		]);

		const merchant = await sent(routes[0]!.id);
		expect(merchant.to).toBe("support@zatos.com");
		expect(merchant.subject).toMatch(/^\[Phishing Support\] \[PS-[0-9a-z]+\] Affiliate 15065 sends deceptive traffic to zatos\.com$/);
		expect(merchant.attachments).toEqual(expect.arrayContaining([FUNNEL_EVIDENCE_NAME, "lure-page-3.png", "offer-page-8.png"]));
		for (const expected of [
			"Hello zatos.com team,",
			"The phishing.support team, which analyses links people report as scams, is reporting affiliate 15065, which sends visitors to your offer on zatos.com through a deceptive funnel. On 2026-11-23 a link reported to us showed what we assess as a fake application for money or benefits; from there the visit continued through affiliate tracking links to your offer. We are writing to the contact help.zatos.com publishes.",
			"Affiliate IDs, as each business in the chain knows them:\n- 15065: affid=15065 on zatos.com; the same ID is the affiliate on miamitrk.com\n- 6RNXHT: affiliate 6RNXHT (in the link path) on onlinesafetyall.com (Everflow link format)\n- 15065: a=15065 on miamitrk.com (CAKE link format); the same ID is the affiliate on zatos.com\n",
			"- miamitrk.com: CAKE (affiliate network or program): a=15065, c=181082, s1=128_, s2=dke0kbl56rbr55umj7k6ku34, s3=3079, clickid=584e52702a4f4436b6d677b95a955ee8, ckmxid=d0o41bd00000gu4vb1j0\n",
			"- www.onlinesafetyall.com: Everflow (affiliate network or program): affiliate 6RNXHT (in the link path), offer 2HSS8TK (in the link path), sub1=3079, sub2=d2d5aa5e17414bd4a51fd8ea730f830a, offer 28DHQGH (in the link path), __ptid=83df736cd5f44c7c9c591bcf5bd74bce, __po=864\n",
			"- wtrck.com: Voluum (the affiliate's own tracker): campaign 4df5378b-a236-4c67-b2d3-cbbb2e9d4b92 (in the link path), s1=128, s3=3079, clickid=584e52702a4f4436b6d677b95a955ee8\n",
			"- zatos.com landing page: affid=15065, sub1=128_",
			"- Our assessment of the lure: The visitor's application for financial assistance was pre-approved and needed one final step.",
			"  - \"Your Financial Assist … Complete the final step to submit your application.\" (" + PRODUCTION_URLS.lure + ", captured 2026-11-23T09:14:04.400Z)",
			"- The offer page shows: \"$19.98/month\"",
			"1. 2026-11-23T09:14:02.000Z  HTTP 302  " + PRODUCTION_URLS.everflowLink + "  [Everflow tracking link]",
			"3. 2026-11-23T09:14:03.400Z  HTTP 302  " + PRODUCTION_URLS.voluumCampaign + "  [tracking link in Voluum's format]",
			"4. 2026-11-23T09:14:04.100Z  HTTP 200  " + PRODUCTION_URLS.lure + "  [lure page shown]",
			"6. 2026-11-23T09:14:05.500Z  HTTP 302  " + PRODUCTION_URLS.wrapper + "  [redirect wrapper]",
			"9. 2026-11-23T09:14:07.600Z  HTTP 200  " + PRODUCTION_URLS.checkout + "  [merchant page]",
			"- 3079: sub1 on onlinesafetyall.com, s3 on wtrck.com, s3 on ultimateprizesearch.com, s3 on miamitrk.com\n",
			"- terminate affiliate 15065 in your affiliate program",
			"- withhold or claw back the commissions paid for this traffic, and review the sales it brought in;",
			"- tell the network that delivered the traffic (onlinesafetyall.com, miamitrk.com) that you terminated the affiliate;",
			`Case details: https://phishing.support/submissions/${submissionId.toString()}`,
		]) expect(merchant.body).toContain(expected);

		const cake = await sent(routes[2]!.id);
		expect(cake.subject).toEndWith("Affiliate 15065 on miamitrk.com (CAKE) sends deceptive traffic to zatos.com");
		expect(cake.body).toStartWith("Hello CAKE team,");
		expect(cake.body).toContain("We found no contact that the operator of miamitrk.com publishes, so we are writing to CAKE as the provider of its CAKE platform: please act on this under your terms of service, or forward this report to your customer who runs miamitrk.com.");
		expect(cake.body).toContain("- terminate affiliate 15065 on your network and stop its campaigns, including the one to zatos.com;");

		const everflow = await sent(routes[1]!.id);
		expect(everflow.subject).toEndWith("Affiliate 6RNXHT on onlinesafetyall.com (Everflow) sends deceptive traffic to zatos.com");
		expect(everflow.body).toContain("Affiliate IDs, as each business in the chain knows them:\n- 6RNXHT: affiliate 6RNXHT (in the link path) on onlinesafetyall.com (Everflow link format)\n");
	});

	test("another case with the same business and affiliate joins the open report instead of mailing again, until the window ends", async () => {
		const first = await newCase();
		const firstReports = (await report(first)).map((outcome) => outcome.kind === "reported" && outcome.reportId);
		const second = await newCase();
		const joined = await report(second);
		expect(joined.map((outcome) => [outcome.kind, outcome.kind === "joined" && outcome.reportId, outcome.kind === "joined" && outcome.caseId])).toEqual(firstReports.map((reportId) => ["joined", reportId, first]));
		expect(joined.map((outcome) => outcome.kind !== "skipped" && outcome.affiliate)).toEqual(["15065", "6RNXHT", "15065"]);
		// A replay joins nothing twice.
		await report(second);
		for (const reportId of firstReports) {
			expect(await AbuseRepository.listJoinedCases(reportId as bigint)).toEqual([second]);
			const events = (await AbuseRepository.listEvents(reportId as bigint)).filter(({ eventType }) => eventType === "report.case_joined");
			expect(events.map(({ data }) => data.submissionId)).toEqual([second.toString()]);
		}
		expect(await AbuseRepository.listReportsForSubmission(second)).toEqual([]);
		expect((await AbuseRepository.listJoinedReportsForSubmission(second)).map(({ id }) => id)).toEqual(firstReports as bigint[]);

		// Past the window, the affiliate is reported anew.
		const db = await getDb();
		for (const reportId of firstReports) await db.update(abuseReports).set({ createdAt: new Date(Date.now() - (FUNNEL_REPORT_WINDOW_DAYS + 1) * DAY_MS) }).where(eq(abuseReports.id, reportId as bigint));
		const afterWindow = await report(await newCase());
		expect(afterWindow.map(({ kind }) => kind)).toEqual(["reported", "reported", "reported"]);
	});

	test("a report that reached nobody does not silence the next case", async () => {
		const first = await newCase();
		const firstReports = (await report(first)).map((outcome) => (outcome as { reportId: bigint }).reportId);
		const db = await getDb();
		await db.update(abuseReports).set({ status: "no_route" }).where(eq(abuseReports.id, firstReports[0]!));
		const next = await report(await newCase());
		expect(next.map(({ kind }) => kind)).toEqual(["reported", "joined", "joined"]);
		expect((next[0] as { reportId: bigint }).reportId).not.toBe(firstReports[0]);
	});

	test("two cases finishing at once create one report per business and affiliate, the other joins it", async () => {
		const [a, b] = await Promise.all([newCase(), newCase()]);
		const [first, second] = await Promise.all([report(a), report(b)]);
		const kinds = [...first!, ...second!].map(({ kind }) => kind).sort();
		expect(kinds).toEqual(["joined", "joined", "joined", "reported", "reported", "reported"]);
		const ids = new Set([...first!, ...second!].map((outcome) => (outcome as { reportId: bigint }).reportId));
		expect(ids.size).toBe(3);
	});

	test("a stand-in recipient chosen while the network's site timed out is retried first, then mailed with what happened", async () => {
		const reportId = ((await report(await newCase()))[2] as { reportId: bigint }).reportId;
		const timingOut = web({ "https://miamitrk.com/": new Error("ETIMEDOUT"), "https://www.miamitrk.com/": new Error("ETIMEDOUT") });
		const resolveTarget = (target: Parameters<typeof resolveAbuseTarget>[0]) => resolveAbuseTarget(target, timingOut);
		await expect(resolveReport(reportId, resolveTarget, 0)).rejects.toBeInstanceOf(IncompleteResolutionError);
		expect(await AbuseRepository.listRoutes(reportId)).toEqual([]);
		await resolveReport(reportId, resolveTarget, RESOLUTION_LOOKUP_RETRIES);
		const [route] = await AbuseRepository.listRoutes(reportId);
		expect(route).toMatchObject({ verifiedEmail: "info@getcake.com", status: "verified" });
		const mail = await sent(route!.id);
		expect(mail.body).toContain("miamitrk.com did not answer when we looked for its operator's contact, so we are writing to CAKE");
		expect(mail.body).not.toContain("publishes no contact");
	});

	test("lookups that keep failing end as a failed resolution without any mail", async () => {
		const [created] = await report(await newCase());
		const reportId = (created as { reportId: bigint }).reportId;
		const failing = web({ "https://zatos.com/": new Error("ETIMEDOUT"), "https://www.zatos.com/": new Error("ETIMEDOUT"), "https://rdap.test/domain/zatos.com": { status: 503 } });
		const resolveTarget = (target: Parameters<typeof resolveAbuseTarget>[0]) => resolveAbuseTarget(target, failing);
		await expect(resolveReport(reportId, resolveTarget, 0)).rejects.toBeInstanceOf(IncompleteResolutionError);
		await resolveReport(reportId, resolveTarget, RESOLUTION_LOOKUP_RETRIES);
		const routes = await AbuseRepository.listRoutes(reportId);
		expect(routes.map(({ routeType, status }) => [routeType, status])).toEqual([["manual_unroutable", "failed"]]);
	});
});

describe("a bounced funnel mail", () => {
	test("goes to the business's next published mailbox, drafted from the same facts", async () => {
		const [merchant] = await report(await newCase());
		const reportId = (merchant as { reportId: bigint }).reportId;
		const twoMailboxes = web({ "https://zatos.com/": { body: `<a href="mailto:affiliates@zatos.com">Affiliates</a> <a href="mailto:support@zatos.com">Support</a>` } });
		const worker = new AbuseWorker({ owner: "funnel-bounce-test", resolveTarget: (target) => resolveAbuseTarget(target, twoMailboxes) });
		while (await worker.processOne({ jobTypes: ["resolve_report"] }));
		const [first] = await AbuseRepository.listRoutes(reportId);
		expect(first!.verifiedEmail).toBe("affiliates@zatos.com");
		const nextId = await routeToNextContact(first!.id);
		const next = (await AbuseRepository.listRoutes(reportId)).find(({ id }) => id === nextId)!;
		expect(next).toMatchObject({ verifiedEmail: "support@zatos.com", status: "verified", providerDisplayName: "zatos.com", resolverProvenance: { source: "funnel_website", foundAt: "https://zatos.com/", bouncedEmails: ["affiliates@zatos.com"] } });
		const mail = await sent(next.id);
		expect(mail.body).toStartWith("Hello zatos.com team,");
		expect(mail.body).toContain("We are writing to the contact zatos.com publishes.");
		expect(mail.body).toContain("- terminate affiliate 15065 in your affiliate program");
	});

	test("to the vendor after the operator's own mailboxes bounced, says so", () => {
		const draft = draftOf({}, 2, {
			providerDisplayName: "CAKE",
			resolverProvenance: { email: "info@getcake.com", source: "funnel_platform_vendor", reason: "fallback_after_permanent_bounce", bouncedEmails: ["info@miamitrk.com"] },
			resolutionSnapshot: { platformVendor: { name: "CAKE", domain: "getcake.com" } },
		});
		expect(draft.body).toContain("The mailboxes miamitrk.com publishes did not accept our report, so we are writing to CAKE as the provider of its CAKE platform");
	});
});
