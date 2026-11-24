import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { runReportInvestigation, type InvestigationDependencies } from "../../investigation/run";
import { readInvestigationJobPayload } from "../../investigation/payload";
import type { WebsiteNavigationHop, WebsiteSiteAssessment } from "../../website/types";
import { AbuseRepository } from "../repository";
import { abuseJobs } from "../schema";
import { reportConfirmedWebsiteAbuse } from "../submission_reports";
import { buildRedirectorRequest, reportRedirector, type RedirectorReportDependencies } from "./redirector_report";
import { redirectorOf, type RedirectorCheck, type RedirectorOf } from "./redirector_watch";
import { navigationHop } from "../../website/test_helpers";

const ROTATOR = "https://openanonymity.chat/x/?ots-cmpgn-refer=TEST_REFERRER";
const ROTATOR_PAGE = `<meta http-equiv="refresh" content="0;url=https://assistdeparments-x.com//"><script>window.location.replace("https://assistdeparments-x.com/");</script>`;
const CAPTURED_AT = new Date("2026-11-11T11:18:20.000Z");
const CHECKED_AT = "2026-11-11T11:19:00.000Z";
// A decodable 1×1 PNG: the destination's screenshot evidence.
const SCREENSHOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");


/** Production case 378865704574652495: the redirector, submitted by hand, sent the case on to the X clone. */
const ROTATOR_HOPS = [navigationHop(0, ROTATOR, { redirectTo: "https://assistdeparments-x.com/" }), navigationHop(1, "https://assistdeparments-x.com/", { contentCaptured: true })];

const REDIRECTOR: RedirectorOf = { url: ROTATOR, destinationUrl: "https://assistdeparments-x.com/", recorded: { caseId: 378865704574652495n, createdAt: CAPTURED_AT, hops: ROTATOR_HOPS }, reportedInCase: false };
const STILL_FORWARDING: RedirectorCheck = {
	kind: "destination",
	url: "https://assistdeparments-x.com/",
	urls: [ROTATOR, "https://assistdeparments-x.com/"],
	page: { url: ROTATOR, status: 200, html: ROTATOR_PAGE },
};
const X_LOGIN = { finding: "phishing" as const, phishingBasis: "credential_theft" as const };

const evidenceJson = (request: ReturnType<typeof buildRedirectorRequest>) => JSON.parse(request.evidence[0]!.buffer.toString("utf8"));

describe("the report of a redirector", () => {
	test("states what the URL did and keeps the recorded chain and today's check as evidence", () => {
		const request = buildRedirectorRequest({
			submissionId: 378865919855693904n,
			sourceReportId: 378866156691263576n,
			redirector: REDIRECTOR,
			destination: { url: "https://assistdeparments-x.com/", finding: X_LOGIN, evidenceQuote: "Email or username" },
			check: { ...STILL_FORWARDING, checkedAt: CHECKED_AT },
			pageScreenshot: { buffer: SCREENSHOT, mimeType: "image/png" },
		});
		expect(request.allegationCategory).toBe("phishing");
		expect(request.targets.map(({ normalizedTarget }) => normalizedTarget)).toEqual(["openanonymity.chat"]);
		expect(request.observedUrls).toEqual([{ target: "openanonymity.chat", urls: [ROTATOR] }]);
		expect(request.description).toBe([
			"This URL forwards visitors to a confirmed credential phishing page: on 2026-11-11T11:18:20.000Z it sent our capture to https://assistdeparments-x.com/, which we confirmed as credential phishing.",
			`That page shows: "Email or username".`,
			"Checked again at 2026-11-11T11:19:00.000Z: it serves a page that immediately sends the visitor on to https://assistdeparments-x.com/.",
			"Disabling this URL stops the links already handed out for this campaign from reaching its current page and the ones it moves to next.",
		].join("\n"));
		expect(request.evidence.map(({ filename, mimeType }) => [filename, mimeType])).toEqual([["redirector-evidence.json", "application/json"], ["lure-page.png", "image/png"]]);
		const evidence = evidenceJson(request);
		expect(evidence.recorded).toEqual({
			capturedAt: CAPTURED_AT.toISOString(),
			caseId: "378865704574652495",
			chain: [{ url: ROTATOR, status: 200, redirectTo: "https://assistdeparments-x.com/" }, { url: "https://assistdeparments-x.com/", status: 200 }],
		});
		expect(evidence.check).toEqual({
			checkedAt: CHECKED_AT,
			kind: "destination",
			urls: STILL_FORWARDING.urls,
			destination: "https://assistdeparments-x.com/",
			page: { url: ROTATOR, status: 200, html: ROTATOR_PAGE, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
		});
		// One report per redirector, whichever case reached it.
		expect(request.idempotencyKey).toMatch(/^redirector:[a-f0-9]{32}$/);
	});

	test("says when the redirector has moved on, redirects by HTTP, or only forwards browsers", () => {
		const build = (check: RedirectorCheck, finding = X_LOGIN as Parameters<typeof buildRedirectorRequest>[0]["destination"]["finding"]) => buildRedirectorRequest({
			submissionId: 1n,
			sourceReportId: 2n,
			redirector: { ...REDIRECTOR, destinationUrl: "https://x-com.email/" },
			destination: { url: "https://x-com.email/", finding },
			check: { ...check, checkedAt: CHECKED_AT },
		});
		const moved = build(STILL_FORWARDING);
		expect(moved.description).toContain("it serves a page that immediately sends the visitor on to https://assistdeparments-x.com/. That is a new host: the campaign moves its pages to new hosts and keeps handing out this URL.");
		expect(moved.description).not.toContain("That page shows");
		expect(moved.evidence).toHaveLength(1);
		expect(build({ kind: "destination", url: "https://x-com.email/login", urls: [] }).description).toContain("Checked again at 2026-11-11T11:19:00.000Z: it redirects to https://x-com.email/login.\n");
		expect(build({ kind: "stays", urls: [ROTATOR] }).description).toContain("the URL still answers; it sends a browser on by script, which a plain HTTP request does not run.");
		const malware = build(STILL_FORWARDING, { finding: "malware" });
		expect(malware.allegationCategory).toBe("malware");
		expect(malware.description).toStartWith("This URL forwards visitors to a confirmed malware distribution page:");
		expect(build(STILL_FORWARDING, { finding: "phishing", phishingBasis: "payment_fraud" }).description).toStartWith("This URL forwards visitors to a confirmed payment fraud page:");
	});
});

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "redirector-test-secret-at-least-32-bytes!"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

const X_PAGE = { finding: "phishing" as const, phishingBasis: "credential_theft" as const, evidenceQuote: "Email or username" };

/**
 * A case whose chain went through `hops` to the page it confirmed and reported, the chain's last page:
 * every hop of the page's site shares its verdict, the others showed nothing.
 */
async function confirmedThrough(id: bigint, hops: WebsiteNavigationHop[], verdicts: Record<number, WebsiteSiteAssessment> = {}) {
	const pageUrl = hops.at(-1)!.url;
	const site = new URL(pageUrl).hostname;
	const assessments: WebsiteSiteAssessment[] = hops.map((hop) => verdicts[hop.index] ?? (hop.hostname === site ? { ...X_PAGE, hopIndex: hop.index, judgedHopIndex: hops.at(-1)!.index } : { hopIndex: hop.index, finding: "insufficient_evidence" }));
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: hops[0]!.url, archiveUrl: pageUrl, routes: [{ hops, analyzedHopIndex: hops.at(-1)!.index, siteAssessments: assessments }] } },
		dedupeKey: `website-${id.toString()}`,
		status: "reported",
	});
	const created = await reportConfirmedWebsiteAbuse({
		submissionId: id,
		urls: [pageUrl],
		analysisText: "The page impersonates X and asks for the account's email or username.",
		reporter: { reporterCountry: "CH" },
		finding: X_LOGIN,
		screenshots: [{ filename: "website.png", png: SCREENSHOT }],
	});
	return { ...created, pageUrl };
}

/** The report step with no network: a fixed popular list and today's check. */
function offline(check: RedirectorCheck = STILL_FORWARDING, popular: string[] = ["x.com", "pstmrk.it"]) {
	const checked: string[] = [];
	let listLoads = 0;
	const dependencies: RedirectorReportDependencies = {
		loadPopularDomains: async () => { listLoads++; return new Set(popular); },
		checkRedirector: async (url) => { checked.push(url); return check; },
		now: () => new Date(CHECKED_AT),
	};
	return { dependencies, checked, listLoads: () => listLoads };
}

const reportsOn = async (submissionId: bigint) => AbuseRepository.listReportsForSubmission(submissionId);

describe("reporting a confirmed page's redirector", () => {
	useTemporaryDatabase();

	test("files one linked report against the redirector, whichever of its destinations is reported", async () => {
		const first = await confirmedThrough(440000000000000002n, ROTATOR_HOPS);
		const net = offline();
		const outcome = await reportRedirector({ reportId: first.reportId, pageUrl: first.pageUrl, submissionId: 440000000000000002n, finding: X_LOGIN, reporter: { reporterCountry: "CH" }, pageScreenshot: async () => ({ buffer: SCREENSHOT, mimeType: "image/png" }) }, net.dependencies);
		expect(outcome).toMatchObject({ kind: "reported", url: ROTATOR, report: { created: true } });
		expect(net.checked).toEqual([ROTATOR]);
		const linked = await AbuseRepository.getReport(outcome?.kind === "reported" ? outcome.report.reportId : 0n);
		expect(linked).toMatchObject({ submissionId: 440000000000000002n, allegationCategory: "phishing" });
		// The capture time is when the case that went through the redirector was opened.
		const recorded = await SubmissionsEntity.get(440000000000000002n);
		expect(linked?.description).toContain(`on ${recorded!.createdAt.toISOString()} it sent our capture to https://assistdeparments-x.com/`);
		expect((await AbuseRepository.listTargets(linked!.id)).map(({ normalizedTarget }) => normalizedTarget)).toEqual(["openanonymity.chat"]);

		// The watch's visit of the redirector later reached the next host.
		const next = await confirmedThrough(440000000000000004n, [navigationHop(0, ROTATOR, { redirectTo: "https://next-kit-host.com/" }), navigationHop(1, "https://next-kit-host.com/", { contentCaptured: true })]);
		const again = await reportRedirector({ reportId: next.reportId, pageUrl: next.pageUrl, submissionId: 440000000000000004n, finding: X_LOGIN, reporter: {}, pageScreenshot: async () => undefined }, offline().dependencies);
		expect(again).toMatchObject({ kind: "reported", report: { reportId: linked!.id, created: false } });
	});

	test("leaves out a mail provider's click tracker, a shortener, and a redirector that is gone", async () => {
		const tracker = await confirmedThrough(440000000000000012n, [
			navigationHop(0, "https://track.pstmrk.it/3s/kit", { status: 302, redirectTo: "https://kit-a-host.com/" }),
			navigationHop(1, "https://kit-a-host.com/", { contentCaptured: true }),
		]);
		const trackerNet = offline();
		expect(await reportRedirector({ reportId: tracker.reportId, pageUrl: tracker.pageUrl, submissionId: 440000000000000012n, finding: X_LOGIN, reporter: {}, pageScreenshot: async () => undefined }, trackerNet.dependencies))
			.toEqual({ kind: "skipped", url: "https://track.pstmrk.it/3s/kit", reason: "a well-known site (Tranco top list), such as a mail provider's click tracker" });
		expect(trackerNet.checked).toEqual([]);

		const shortener = await confirmedThrough(440000000000000014n, [
			navigationHop(0, "https://bit.ly/3kitXyz", { status: 301, redirectTo: "https://kit-b-host.com/" }),
			navigationHop(1, "https://kit-b-host.com/", { contentCaptured: true }),
		]);
		const shortenerNet = offline();
		expect(await reportRedirector({ reportId: shortener.reportId, pageUrl: shortener.pageUrl, submissionId: 440000000000000014n, finding: X_LOGIN, reporter: {}, pageScreenshot: async () => undefined }, shortenerNet.dependencies))
			.toMatchObject({ kind: "skipped", reason: "a shared link service, whose links are reported to the service itself" });
		expect(shortenerNet.listLoads()).toBe(0);

		const gone = await confirmedThrough(440000000000000016n, ROTATOR_HOPS.map((item) => ({ ...item, url: item.url.replace("assistdeparments-x.com", "kit-c-host.com"), redirectTo: item.redirectTo?.replace("assistdeparments-x.com", "kit-c-host.com") })));
		expect(await reportRedirector({ reportId: gone.reportId, pageUrl: gone.pageUrl, submissionId: 440000000000000016n, finding: X_LOGIN, reporter: {}, pageScreenshot: async () => undefined }, offline({ kind: "unreachable", reason: "queryA ENOTFOUND openanonymity.chat", urls: [] }).dependencies))
			.toEqual({ kind: "skipped", url: ROTATOR, reason: "it no longer answers (queryA ENOTFOUND openanonymity.chat)" });
		for (const id of [440000000000000012n, 440000000000000014n, 440000000000000016n]) expect(await reportsOn(id)).toHaveLength(1);
	});

	test("does nothing for a page that was submitted directly, or reached by acting on a page of the flow", async () => {
		const net = offline();
		const direct = await confirmedThrough(440000000000000021n, [navigationHop(0, "https://kit-d-host.com/", { contentCaptured: true })]);
		expect(await reportRedirector({ reportId: direct.reportId, pageUrl: direct.pageUrl, submissionId: 440000000000000021n, finding: X_LOGIN, reporter: {}, pageScreenshot: async () => { throw new Error("must not be read"); } }, net.dependencies)).toBeUndefined();
		// The visit pressed "Continue" on the lure: a step of the flow, not something that hands out the kit.
		const stepped = await confirmedThrough(440000000000000022n, [navigationHop(0, "https://lure-e.com/", { redirectTo: "https://kit-e-host.com/", visitorStep: { submitted: [] } }), navigationHop(1, "https://kit-e-host.com/", { contentCaptured: true })]);
		expect(await reportRedirector({ reportId: stepped.reportId, pageUrl: stepped.pageUrl, submissionId: 440000000000000022n, finding: X_LOGIN, reporter: {}, pageScreenshot: async () => { throw new Error("must not be read"); } }, net.dependencies)).toBeUndefined();
		expect(net.listLoads()).toBe(0);
		expect(net.checked).toEqual([]);
	});

	test("takes the hop just before the chain reaches the reported site, however many sites came before it", async () => {
		// The design's example chain: the confirmed site is reached through trackers and an interstitial.
		const chain = [
			navigationHop(0, "https://onlinesafetyall.com/", { status: 302, redirectTo: "https://wtrck.com/a" }),
			navigationHop(1, "https://wtrck.com/a", { status: 302, redirectTo: "https://ultimateprizesearch.com/" }),
			navigationHop(2, "https://ultimateprizesearch.com/", { redirectTo: "https://miamitrk.com/c" }),
			navigationHop(3, "https://miamitrk.com/c", { status: 302, redirectTo: "https://zatos-kit.com/" }),
			navigationHop(4, "https://zatos-kit.com/", { status: 302, redirectTo: "https://zatos-kit.com/login" }),
			navigationHop(5, "https://zatos-kit.com/login", { contentCaptured: true }),
		];
		const page = await confirmedThrough(440000000000000041n, chain);
		const redirector = await redirectorOf(440000000000000041n, page.pageUrl);
		expect(redirector).toMatchObject({ url: "https://miamitrk.com/c", destinationUrl: "https://zatos-kit.com/login", recorded: { caseId: 440000000000000041n, hops: chain }, reportedInCase: false });
		expect(redirector?.destinationAssessment).toMatchObject({ finding: "phishing", evidenceQuote: "Email or username" });
		// Each site of the chain has the hop that brought the chain to it; a site not in the chain has none.
		expect((await redirectorOf(440000000000000041n, "https://ultimateprizesearch.com/"))?.url).toBe("https://wtrck.com/a");
		expect(await redirectorOf(440000000000000041n, "https://elsewhere.example/")).toBeUndefined();
	});

	test("leaves out a redirector whose own site the case confirmed: it has its own report", async () => {
		const lure = "https://rotator-kit.com/start";
		const hops = [navigationHop(0, lure, { redirectTo: "https://final-kit.com/" }), navigationHop(1, "https://final-kit.com/", { contentCaptured: true })];
		const page = await confirmedThrough(440000000000000051n, hops, { 0: { ...X_PAGE, hopIndex: 0, judgedHopIndex: 0 } });
		const net = offline();
		expect(await reportRedirector({ reportId: page.reportId, pageUrl: page.pageUrl, submissionId: 440000000000000051n, finding: X_LOGIN, reporter: {}, pageScreenshot: async () => undefined }, net.dependencies))
			.toEqual({ kind: "skipped", url: lure, reason: "its site is confirmed in the same chain and reported in its own right" });
		expect(net.checked).toEqual([]);
	});

	test("the investigation reports the redirector with the page's screenshot before it releases the page's report", async () => {
		const page = await confirmedThrough(440000000000000032n, ROTATOR_HOPS);
		const job = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.reportId, page.reportId)).all().find(({ jobType }) => jobType === "investigate_report")!;
		const net = offline();
		const deps: Partial<InvestigationDependencies> = {
			reportRedirector: (params) => reportRedirector(params, net.dependencies),
			now: () => new Date(CHECKED_AT),
		};
		await runReportInvestigation({ reportId: page.reportId, payload: readInvestigationJobPayload(job.payload), reporter: { reporterCountry: "CH" } }, deps);

		expect((await AbuseRepository.getReport(page.reportId))?.status).toBe("accepted");
		const reports = await reportsOn(440000000000000032n);
		expect(reports).toHaveLength(2);
		const redirector = reports.find(({ id }) => id !== page.reportId)!;
		const input = await AbuseRepository.getReportInput(redirector.id);
		expect(input?.evidenceArtifacts.map(({ mimeType }) => mimeType).sort()).toEqual(["application/json", "image/png"]);
		const events = (await AbuseRepository.listEvents(page.reportId)).filter(({ eventType }) => eventType.startsWith("redirector."));
		expect(events.map(({ eventType, data }) => [eventType, data])).toEqual([["redirector.reported", { submissionId: expect.any(String), url: ROTATOR, reportId: redirector.id.toString(), created: true }]]);

		// A retried investigation finds the same report.
		await runReportInvestigation({ reportId: page.reportId, payload: readInvestigationJobPayload(job.payload), reporter: {} }, deps);
		expect(await reportsOn(440000000000000032n)).toHaveLength(2);
	});
});
