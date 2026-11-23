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
import { buildFunnelReportRequests, reportDeceptiveFunnel } from "./report";
import { PRODUCTION_URLS, productionChain, rdapDomain, web, ZATOS_HOME } from "./test_fixtures";

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

describe("buildFunnelReportRequests", () => {
	test("one report per business: the merchant and each network, each targeting the affiliate there", () => {
		const requests = buildFunnelReportRequests({ submissionId: 42n, chain, extraction, verdict });
		expect(requests.map((request) => request.targets[0]!.normalizedTarget)).toEqual([
			"affiliate:merchant:-:zatos.com:15065",
			"affiliate:network:everflow:onlinesafetyall.com:6RNXHT",
			"affiliate:network:cake:miamitrk.com:15065",
		]);
		for (const request of requests) {
			expect(request).toMatchObject({ allegationCategory: "fraud", targets: [{ targetType: "service_account" }] });
			expect(request.idempotencyKey).toMatch(/^funnel:42:[0-9a-f]{32}$/);
			expect(request.evidence.map(({ filename, mimeType }) => [filename, mimeType])).toEqual([
				[FUNNEL_EVIDENCE_NAME, "application/json"],
				["lure-page-3.png", "image/png"],
				["offer-page-8.png", "image/png"],
			]);
			expect(request.targets[0]!.observedUrls).toEqual(expect.arrayContaining([PRODUCTION_URLS.everflowLink, PRODUCTION_URLS.wrapper, PRODUCTION_URLS.cakeLink, PRODUCTION_URLS.checkout]));
			expect(request.description.split(/\s+/).length).toBeLessThan(30);
		}
		expect(new Set(requests.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(3);
		expect(requests[0]!.description).toBe("Deceptive affiliate funnel into zatos.com: Affiliate 15065 sent visitors to the offer from a fake application for money or benefits.");
		expect(requests[2]!.description).toBe("Deceptive affiliate funnel through miamitrk.com (CAKE): Affiliate 15065 sent visitors from a fake application for money or benefits to zatos.com.");
	});

	test("the facts file holds the whole chain, every tracker and the verbatim quotes", () => {
		const [merchant] = buildFunnelReportRequests({ submissionId: 42n, chain, extraction, verdict });
		const facts = readFunnelFacts(merchant!.evidence.map(({ filename, buffer }) => ({ filename, content: buffer })))!;
		expect(facts.party).toEqual({ role: "merchant", site: "zatos.com", affiliateId: "15065" });
		expect(facts.chain).toHaveLength(9);
		expect(facts.chain[5]).toEqual({ index: 5, at: "2026-11-23T09:14:05.500Z", status: 302, url: PRODUCTION_URLS.wrapper, redirectTo: PRODUCTION_URLS.cakeLink, kind: "redirector" });
		expect(facts.trackers.map(({ platform }) => platform)).toEqual(["everflow", "everflow", "voluum", "voluum", "cake", "cake"]);
		expect(facts.deception.lureQuotes).toEqual([{ hopIndex: 3, url: PRODUCTION_URLS.lure, capturedAt: "2026-11-23T09:14:04.400Z", quote: "Your Financial Assist … Complete the final step to submit your application." }]);
		expect(facts.deception.offerQuote).toMatchObject({ hopIndex: 8, quote: "$19.98/month" });
		expect(facts.screenshots.map(({ filename }) => filename)).toEqual(["lure-page-3.png", "offer-page-8.png"]);
		expect(facts.carriedValues.some(({ value }) => value === "3079")).toBeTrue();
	});

	test("a quote that is no longer verbatim page text drops out; with none left there is no report", () => {
		const changed = { ...chain, pages: chain.pages.map((page) => page.hopIndex === 3 ? { ...page, text: "A different page" } : page) };
		expect(() => buildFunnelReportRequests({ submissionId: 42n, chain: changed, extraction, verdict })).toThrow("verbatim");
	});

	test("screenshots over the evidence limits are left out, the facts still name every page", () => {
		const big = Buffer.alloc(6 * 1024 * 1024);
		const heavy = { ...chain, pages: chain.pages.map((page) => page.hopIndex === 3 ? { ...page, screenshot: { buffer: big, mimeType: "image/png" as const } } : page) };
		const [request] = buildFunnelReportRequests({ submissionId: 42n, chain: heavy, extraction, verdict });
		expect(request!.evidence.map(({ filename }) => filename)).toEqual([FUNNEL_EVIDENCE_NAME, "offer-page-8.png"]);
	});

	test("a chain without merchant and networks has no report to make", () => {
		expect(buildFunnelReportRequests({ submissionId: 42n, chain, extraction: { ...extraction, parties: [] }, verdict })).toEqual([]);
	});
});

describe("createFunnelEmailDraft", () => {
	const route = { providerDisplayName: "zatos.com", resolverProvenance: { email: "support@zatos.com", source: "website", foundAt: "https://help.zatos.com/terms/index-antivirus.php" }, resolutionSnapshot: {} };

	test("leaves every other report to the generic draft", () => {
		expect(createFunnelEmailDraft({ report: { id: 1n, submissionId: 2n }, target: { normalizedTarget: "telegram-bot:1", observedUrls: [] }, route })).toBeUndefined();
	});

	test("refuses to draft a funnel report whose facts are missing or corrupted", () => {
		const target = { normalizedTarget: "affiliate:merchant:-:zatos.com:15065", observedUrls: [] };
		expect(() => createFunnelEmailDraft({ report: { id: 1n, submissionId: 2n }, target, route })).toThrow(FUNNEL_EVIDENCE_NAME);
		expect(() => createFunnelEmailDraft({ report: { id: 1n, submissionId: 2n }, target, route, evidence: [{ filename: FUNNEL_EVIDENCE_NAME, mimeType: "application/json", content: Buffer.from("{\"kind\":\"deceptive_funnel\"}") }] })).toThrow(FUNNEL_EVIDENCE_NAME);
	});

	test("prints only the URLs the report recorded; any other by its host", () => {
		const [request] = buildFunnelReportRequests({ submissionId: 42n, chain, extraction, verdict });
		const evidence = request!.evidence.map(({ filename, mimeType, buffer }) => ({ filename, mimeType, content: buffer }));
		const draft = createFunnelEmailDraft({ report: { id: 1n, submissionId: 42n }, target: { normalizedTarget: request!.targets[0]!.normalizedTarget, observedUrls: [PRODUCTION_URLS.checkout] }, route, evidence })!;
		expect(draft.body).toContain(PRODUCTION_URLS.checkout);
		expect(draft.body).not.toContain(PRODUCTION_URLS.everflowLink);
		expect(draft.body).toContain(`www.onlinesafetyall.com (full URL in ${FUNNEL_EVIDENCE_NAME})`);
		expect(draft.body).toContain("We are writing to the contact help.zatos.com publishes.");
	});
});

describe("a bounced funnel mail", () => {
	test("goes to the business's next published mailbox, drafted from the same facts", async () => {
		const url = PRODUCTION_URLS.everflowLink;
		const submissionId = await SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url } }, dedupeKey: `website-${url}` });
		const [merchant] = await reportDeceptiveFunnel({ submissionId, chain, extraction, verdict, reporter: {} });
		const deps = web({ "https://zatos.com/": { body: `<a href="mailto:affiliates@zatos.com">Affiliates</a> <a href="mailto:support@zatos.com">Support</a>` } });
		const worker = new AbuseWorker({ owner: "funnel-bounce-test", resolveTarget: (target) => resolveAbuseTarget(target, deps) });
		while (await worker.processOne({ jobTypes: ["resolve_report"] }));
		const [first] = await AbuseRepository.listRoutes(merchant!.reportId);
		expect(first!.verifiedEmail).toBe("affiliates@zatos.com");
		const nextId = await routeToNextContact(first!.id);
		const next = (await AbuseRepository.listRoutes(merchant!.reportId)).find(({ id }) => id === nextId)!;
		expect(next).toMatchObject({ verifiedEmail: "support@zatos.com", status: "verified", providerDisplayName: "zatos.com", resolverProvenance: { source: "website", foundAt: "https://zatos.com/", bouncedEmails: ["affiliates@zatos.com"] } });
		let body = "";
		await sendEmail(next.id, {
			markUnknownExternal: async ({ error }) => {
				throw new Error(error);
			},
			send: async (params) => {
				body = params.body;
				return { messageId: 1n, status: "sent", rfcMessageId: "<bounce@phishing.support>" };
			},
		});
		expect(body).toStartWith("Hello zatos.com affiliate compliance team,");
		expect(body).toContain("We are writing to the contact zatos.com publishes.");
		expect(body).toContain("- terminate affiliate 15065 in your affiliate program");
	});
});

describe("reportDeceptiveFunnel through the worker", () => {
	const deps = web({
		"https://zatos.com/": { status: 301, location: "https://www.zatos.com/" },
		"https://www.zatos.com/": { body: ZATOS_HOME },
		"https://help.zatos.com/terms/index-antivirus.php": { body: "<p>Questions? Email <a href=\"mailto:support@zatos.com\">support@zatos.com</a></p>" },
		"https://rdap.test/domain/zatos.com": rdapDomain("zatos.com", { email: "c5@withheldforprivacy.com", org: "Privacy service provided by Withheld for Privacy ehf" }),
		"https://onlinesafetyall.com/": { body: "<title>Performance Marketing Platform</title><h1>Performance Tracking</h1>" },
		"https://miamitrk.com/": { body: "<html></html>" },
		"https://rdap.test/domain/miamitrk.com": rdapDomain("miamitrk.com", { email: "c1@withheldforprivacy.com", name: "Redacted for Privacy Purposes" }),
	});

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

	test("creates the reports, resolves each recipient without an operator, and mails the merchant and the networks", async () => {
		const url = PRODUCTION_URLS.everflowLink;
		const submissionId = await SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url } }, dedupeKey: `website-${url}` });
		const reports = await reportDeceptiveFunnel({ submissionId, chain, extraction, verdict, reporter: {} });
		expect(reports.map(({ created }) => created)).toEqual([true, true, true]);
		// Created again by a replayed analysis: the same reports.
		expect((await reportDeceptiveFunnel({ submissionId, chain, extraction, verdict, reporter: {} })).map(({ reportId }) => reportId)).toEqual(reports.map(({ reportId }) => reportId));

		const worker = new AbuseWorker({ owner: "funnel-test", resolveTarget: (target) => resolveAbuseTarget(target, deps) });
		for (let index = 0; index < 3; index++) expect(await worker.processOne({ jobTypes: ["resolve_report"] })).toBeTrue();

		const routes = await Promise.all(reports.map(async ({ reportId }) => (await AbuseRepository.listRoutes(reportId))[0]!));
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
			"Hello zatos.com affiliate compliance team,",
			"The phishing.support team, which analyses links people report as scams, is reporting affiliate 15065, which sends visitors to your offer on zatos.com through a deceptive funnel. On 2026-11-23 a link reported to us showed a fake application for money or benefits, and its button led through affiliate tracking links to your offer. We are writing to the contact help.zatos.com publishes.",
			"Affiliate IDs, as each business in the chain knows them:\n- 15065: affid=15065 on zatos.com; the same ID is the affiliate on miamitrk.com\n- 6RNXHT: affiliate 6RNXHT (in the link path) on onlinesafetyall.com (Everflow)\n- 15065: a=15065 on miamitrk.com (CAKE); the same ID is the affiliate on zatos.com\n",
			"- miamitrk.com: CAKE (affiliate network or program): a=15065, c=181082, s1=128_, s2=dke0kbl56rbr55umj7k6ku34, s3=3079, clickid=584e52702a4f4436b6d677b95a955ee8, ckmxid=d0o41bd00000gu4vb1j0\n",
			"- www.onlinesafetyall.com: Everflow (affiliate network or program): affiliate 6RNXHT (in the link path), offer 2HSS8TK (in the link path), sub1=3079, sub2=d2d5aa5e17414bd4a51fd8ea730f830a, offer 28DHQGH (in the link path), __ptid=83df736cd5f44c7c9c591bcf5bd74bce, __po=864\n",
			"- wtrck.com: Voluum (the affiliate's own tracker): campaign 4df5378b-a236-4c67-b2d3-cbbb2e9d4b92 (in the link path), s1=128, s3=3079, clickid=584e52702a4f4436b6d677b95a955ee8\n",
			"- zatos.com landing page: affid=15065, sub1=128_",
			"- The lure claimed: The visitor's application for financial assistance was pre-approved and needed one final step.",
			"  - \"Your Financial Assist … Complete the final step to submit your application.\" (" + PRODUCTION_URLS.lure + ", captured 2026-11-23T09:14:04.400Z)",
			"- The offer page shows: \"$19.98/month\"",
			"1. 2026-11-23T09:14:02.000Z  HTTP 302  " + PRODUCTION_URLS.everflowLink + "  [Everflow tracking link]",
			"4. 2026-11-23T09:14:04.100Z  HTTP 200  " + PRODUCTION_URLS.lure + "  [lure page shown]",
			"6. 2026-11-23T09:14:05.500Z  HTTP 302  " + PRODUCTION_URLS.wrapper + "  [redirect wrapper]",
			"9. 2026-11-23T09:14:07.600Z  HTTP 200  " + PRODUCTION_URLS.checkout + "  [merchant page]",
			"- 3079: sub1 on onlinesafetyall.com, s3 on wtrck.com, s3 on ultimateprizesearch.com, s3 on miamitrk.com\n",
			"- terminate affiliate 15065 in your affiliate program",
			"- withhold or claw back the commissions paid for this traffic, and refund the customers it brought in;",
			`Case details: https://phishing.support/submissions/${submissionId.toString()}`,
		]) expect(merchant.body).toContain(expected);

		const cake = await sent(routes[2]!.id);
		expect(cake.subject).toEndWith("Affiliate 15065 on miamitrk.com (CAKE) sends deceptive traffic to zatos.com");
		expect(cake.body).toStartWith("Hello CAKE team,");
		expect(cake.body).toContain("The operator of miamitrk.com publishes no contact, so we are writing to CAKE as the provider of its CAKE platform: please act on this under your terms of service, or forward this report to your customer who runs miamitrk.com.");
		expect(cake.body).toContain("- terminate affiliate 15065 on your network and stop its campaigns, including the one to zatos.com;");

		// The merchant's mailbox bounced: its next published contact gets the same funnel mail.
		const merchantRoutes = await AbuseRepository.listRoutes(reports[0]!.reportId);
		expect(await routeToNextContact(merchantRoutes[0]!.id)).toBeUndefined();

		const everflow = await sent(routes[1]!.id);
		expect(everflow.subject).toEndWith("Affiliate 6RNXHT on onlinesafetyall.com (Everflow) sends deceptive traffic to zatos.com");
		expect(everflow.body).toContain("Affiliate IDs, as each business in the chain knows them:\n- 6RNXHT: affiliate 6RNXHT (in the link path) on onlinesafetyall.com (Everflow)\n");
		expect(everflow.body).toContain("- terminate affiliate 6RNXHT on your network");
	});
});
