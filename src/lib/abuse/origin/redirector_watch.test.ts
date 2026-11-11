import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { SubmissionsEntity } from "../../db/entities";
import { submissions } from "../../db/schema";
import { useTemporaryDatabase } from "../../db/test_helpers";
import type { AnalyzeWebsiteOptions } from "../../website_ai";
import type { WebsiteNavigationHop } from "../../website_types";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { abuseJobs, type AbuseJob } from "../schema";
import {
	checkRedirector,
	documentRedirect,
	enqueueRedirectorWatch,
	REDIRECTOR_WATCH_INTERVAL_MS,
	redirectorHop,
	type RedirectorCheck,
	type RedirectorWatchState,
	watchRedirector,
} from "./redirector_watch";

const ROTATOR = "https://openanonymity.chat/x/?ots-cmpgn-refer=TEST_REFERRER";

/** openanonymity.chat/x/ as it answered on 2026-11-11. */
const ROTATOR_PAGE = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="0;url=https://assistdeparments-x.com//">
    <script>
        window.location.replace("https://assistdeparments-x.com/");
    </script>
</head>
<body></body>
</html>`;

describe("a page that sends its visitor on by itself", () => {
	test("reads a meta refresh before a script, in either attribute order and quoting", () => {
		expect(documentRedirect(ROTATOR_PAGE, ROTATOR)).toBe("https://assistdeparments-x.com//");
		expect(documentRedirect(`<meta content="5; URL='/next?a=1'" http-equiv="Refresh">`, "https://r.example/x/")).toBe("https://r.example/next?a=1");
		expect(documentRedirect(`<meta http-equiv=refresh content="0.5,url=https://kit.example/">`, "https://r.example/")).toBe("https://kit.example/");
		// A refresh without a target only reloads the page.
		expect(documentRedirect(`<meta http-equiv="refresh" content="30">`, "https://r.example/")).toBeUndefined();
	});

	test("reads a literal location assignment in an inline script", () => {
		const page = (script: string) => `<html><body><script>${script}</script></body></html>`;
		expect(documentRedirect(page(`window.location.replace("https://kit.example/a")`), "https://r.example/")).toBe("https://kit.example/a");
		expect(documentRedirect(page(`location.href = 'https://kit.example/b';`), "https://r.example/")).toBe("https://kit.example/b");
		expect(documentRedirect(page("document.location = `https://kit.example/c`"), "https://r.example/")).toBe("https://kit.example/c");
		expect(documentRedirect(page(`top.location="/relative"`), "https://r.example/x/")).toBe("https://r.example/relative");
		expect(documentRedirect(page(`location.assign( "https://kit.example/d" )`), "https://r.example/")).toBe("https://kit.example/d");
	});

	test("leaves computed targets, other schemes, external scripts and page text to the browser", () => {
		const page = (body: string) => `<html><body>${body}</body></html>`;
		expect(documentRedirect(page(`<script>location.href = atob("aHR0cHM6Ly9raXQuZXhhbXBsZS8=")</script>`), "https://r.example/")).toBeUndefined();
		expect(documentRedirect(page(`<script>location.href = "javascript:alert(1)"</script>`), "https://r.example/")).toBeUndefined();
		expect(documentRedirect(page(`<meta http-equiv="refresh" content="0;url=data:text/html,hi">`), "https://r.example/")).toBeUndefined();
		expect(documentRedirect(page(`<script src="/go.js">location.href = "https://kit.example/"</script>`), "https://r.example/")).toBeUndefined();
		expect(documentRedirect(page(`<p>Set location.href = "https://kit.example/" to continue</p>`), "https://r.example/")).toBeUndefined();
		expect(documentRedirect(page(`<script>var location2 = "https://kit.example/"; const relocation = "https://kit.example/"</script>`), "https://r.example/")).toBeUndefined();
		expect(documentRedirect(page(`<a href="https://kit.example/">Continue</a>`), "https://r.example/")).toBeUndefined();
	});
});

type Answer = { status?: number; location?: string; body?: string; contentType?: string };

/** A web of hosts for the cheap check: which answer each URL gets, and which hosts are not public or do not resolve. */
function web(answers: Record<string, Answer>, unsafeHosts: Record<string, string> = {}) {
	const requested: string[] = [];
	const dependencies = {
		fetch: async (input: string | URL, init?: RequestInit) => {
			const url = input.toString();
			requested.push(url);
			expect(init?.redirect).toBe("manual");
			const answer = answers[url];
			if (!answer) throw new TypeError(`fetch failed: ${url} refused the connection`);
			const headers: Record<string, string> = { "content-type": answer.contentType ?? "text/html; charset=utf-8" };
			if (answer.location) headers.location = answer.location;
			return new Response(answer.body ?? "", { status: answer.status ?? 200, headers });
		},
		assertPublicHost: async (hostname: string) => {
			if (unsafeHosts[hostname]) throw new Error(unsafeHosts[hostname]);
		},
	};
	return { dependencies, requested };
}

describe("the cheap check of a redirector", () => {
	test("follows HTTP redirects, a refresh page and the kit's own redirects to where the visitor ends up", async () => {
		const { dependencies, requested } = web({
			"https://openanonymity.chat/x?ots-cmpgn-refer=TEST_REFERRER": { status: 301, location: "/x/?ots-cmpgn-refer=TEST_REFERRER" },
			[ROTATOR]: { body: ROTATOR_PAGE },
			"https://assistdeparments-x.com//": { status: 302, location: "https://assistdeparments-x.com/" },
			"https://assistdeparments-x.com/": { body: "<title>X. It’s what’s happening / X</title>" },
		});
		const check = await checkRedirector("https://openanonymity.chat/x?ots-cmpgn-refer=TEST_REFERRER", dependencies);
		expect(check).toEqual({
			kind: "destination",
			url: "https://assistdeparments-x.com/",
			urls: ["https://openanonymity.chat/x?ots-cmpgn-refer=TEST_REFERRER", ROTATOR, "https://assistdeparments-x.com//", "https://assistdeparments-x.com/"],
			// The redirector's own page is kept as evidence; the kit's pages are not.
			page: { url: ROTATOR, status: 200, html: ROTATOR_PAGE },
		});
		expect(requested).toEqual(check.urls);
	});

	test("names the destination even when the kit host it leads to is gone or not public", async () => {
		// x-com.email after Railway dropped it: the redirector still pointed there.
		const gone = web({ [ROTATOR]: { body: ROTATOR_PAGE } }, { "assistdeparments-x.com": "queryA ENOTFOUND assistdeparments-x.com" });
		expect(await checkRedirector(ROTATOR, gone.dependencies)).toEqual({
			kind: "destination",
			url: "https://assistdeparments-x.com//",
			urls: [ROTATOR, "https://assistdeparments-x.com//"],
			page: { url: ROTATOR, status: 200, html: ROTATOR_PAGE },
		});
		expect(gone.requested).toEqual([ROTATOR]);

		const errors = web({ [ROTATOR]: { status: 302, location: "https://kit.example/" }, "https://kit.example/": { status: 404 } });
		expect(await checkRedirector(ROTATOR, errors.dependencies)).toMatchObject({ kind: "destination", url: "https://kit.example/" });

		// A redirect into the private network is recorded, never requested.
		const internal = web({ [ROTATOR]: { status: 302, location: "http://10.0.0.5/admin" } }, { "10.0.0.5": "Host resolves to a non-public address." });
		expect(await checkRedirector(ROTATOR, internal.dependencies)).toMatchObject({ kind: "destination", url: "http://10.0.0.5/admin" });
		expect(internal.requested).toEqual([ROTATOR]);
	});

	test("reports a redirector that does not answer, answers with an error, or does not resolve", async () => {
		const refused = web({});
		expect(await checkRedirector(ROTATOR, refused.dependencies)).toEqual({ kind: "unreachable", reason: expect.stringContaining("refused the connection"), urls: [ROTATOR] });
		expect(await checkRedirector(ROTATOR, web({ [ROTATOR]: { status: 404, body: "Not Found" } }).dependencies))
			.toEqual({ kind: "unreachable", reason: `HTTP 404 at ${ROTATOR}`, urls: [ROTATOR] });
		const nxdomain = web({}, { "openanonymity.chat": "queryA ENOTFOUND openanonymity.chat" });
		expect(await checkRedirector(ROTATOR, nxdomain.dependencies)).toMatchObject({ kind: "unreachable", reason: expect.stringContaining("ENOTFOUND") });
		expect(nxdomain.requested).toEqual([]);
		// A same-site redirect that then fails is still the redirector failing.
		const internalHop = web({ [ROTATOR]: { status: 302, location: "https://openanonymity.chat/y/" } });
		expect(await checkRedirector(ROTATOR, internalHop.dependencies)).toMatchObject({ kind: "unreachable", urls: [ROTATOR, "https://openanonymity.chat/y/"] });
	});

	test("says the redirector stays put when its page sends the visitor nowhere a plain client can follow", async () => {
		// A cloaker that computes its target in script, a page that refreshes itself, a non-HTML answer.
		const computed = `<script>location.href = atob("aHR0cHM6Ly9raXQuZXhhbXBsZS8=")</script>`;
		expect(await checkRedirector(ROTATOR, web({ [ROTATOR]: { body: computed } }).dependencies))
			.toEqual({ kind: "stays", urls: [ROTATOR], page: { url: ROTATOR, status: 200, html: computed } });
		const refresh = `<meta http-equiv="refresh" content="0;url=${ROTATOR}">`;
		const loop = web({ [ROTATOR]: { body: refresh } });
		expect(await checkRedirector(ROTATOR, loop.dependencies)).toEqual({ kind: "stays", urls: [ROTATOR], page: { url: ROTATOR, status: 200, html: refresh } });
		expect(loop.requested).toEqual([ROTATOR]);
		const binary = web({ [ROTATOR]: { body: `location.href = "https://kit.example/"`, contentType: "application/octet-stream" } });
		expect(await checkRedirector(ROTATOR, binary.dependencies)).toEqual({ kind: "stays", urls: [ROTATOR] });
		const huge = web({ [ROTATOR]: { body: `${" ".repeat(600 * 1024)}<script>location.href = "https://kit.example/"</script>` } });
		expect(await checkRedirector(ROTATOR, huge.dependencies)).toEqual({ kind: "stays", urls: [ROTATOR] });
	});

	test("keeps at most 64 KiB of the redirector's page as evidence, and only of a page it read", async () => {
		const padded = `<meta http-equiv="refresh" content="0;url=https://kit.example/">${"x".repeat(100 * 1024)}`;
		const check = await checkRedirector(ROTATOR, web({ [ROTATOR]: { body: padded }, "https://kit.example/": { body: "kit" } }).dependencies);
		expect(check).toMatchObject({ kind: "destination", url: "https://kit.example/" });
		expect(check.page?.html).toBe(padded.slice(0, 64 * 1024));
		// An HTTP redirect has no page; neither has an error answer.
		expect((await checkRedirector(ROTATOR, web({ [ROTATOR]: { status: 302, location: "https://kit.example/" }, "https://kit.example/": { body: "kit" } }).dependencies)).page).toBeUndefined();
		expect((await checkRedirector(ROTATOR, web({ [ROTATOR]: { status: 404, body: "gone" } }).dependencies)).page).toBeUndefined();
	});

	test("stops following a chain of refresh pages after a bounded number", async () => {
		const answers: Record<string, Answer> = {};
		for (let page = 0; page < 20; page++) answers[`https://r.example/${page}`] = { body: `<meta http-equiv="refresh" content="0;url=/${page + 1}">` };
		const chain = web(answers);
		expect(await checkRedirector("https://r.example/0", chain.dependencies)).toMatchObject({ kind: "stays" });
		expect(chain.requested).toHaveLength(6);
	});
});

const hop = (index: number, url: string, extra: Partial<WebsiteNavigationHop> = {}): WebsiteNavigationHop => ({ index, url, hostname: new URL(url).hostname, status: 200, contentCaptured: false, ...extra });

/** The hops of the email link in case 378201607612928051. */
const EMAIL_LINK_HOPS: WebsiteNavigationHop[] = [
	hop(0, "https://tr.slicksalon.com/t/c/23701074", { status: 302, redirectTo: "https://track.pstmrk.it/3s/openanonymity.chat" }),
	hop(1, "https://track.pstmrk.it/3s/openanonymity.chat", { status: 302, redirectTo: "https://openanonymity.chat/x?ots-cmpgn-refer=TEST_REFERRER" }),
	hop(2, "https://openanonymity.chat/x?ots-cmpgn-refer=TEST_REFERRER", { status: 301, redirectTo: ROTATOR }),
	hop(3, ROTATOR, { redirectTo: "https://x-com.email/" }),
	hop(4, "https://x-com.email/", { contentCaptured: true }),
];

describe("which page of a chain is the redirector", () => {
	test("is the last page before the destination's site that sent the visitor on by itself", () => {
		expect(redirectorHop(EMAIL_LINK_HOPS, "https://x-com.email/")?.url).toBe(ROTATOR);
		// The destination's own redirects are part of the destination.
		expect(redirectorHop([...EMAIL_LINK_HOPS.slice(0, 4), hop(4, "https://x-com.email/", { status: 302, redirectTo: "https://x-com.email/login" }), hop(5, "https://x-com.email/login")], "https://x-com.email/login")?.url).toBe(ROTATOR);
	});

	test("is none when the visitor had to act, or the chain never left the destination", () => {
		expect(redirectorHop([hop(0, "https://landing.example/", { redirectTo: "https://kit.example/", followedLink: { label: "Continue" } }), hop(1, "https://kit.example/")], "https://kit.example/")).toBeUndefined();
		expect(redirectorHop([hop(0, "https://landing.example/", { redirectTo: "https://kit.example/", performedAction: { kind: "click", control: { ref: "b1", label: "Open" } } }), hop(1, "https://kit.example/")], "https://kit.example/")).toBeUndefined();
		expect(redirectorHop([hop(0, "https://kit.example/")], "https://kit.example/")).toBeUndefined();
		expect(redirectorHop(EMAIL_LINK_HOPS, "https://elsewhere.example/")).toBeUndefined();
	});
});

const PARENT_ID = 430000000000000001n;
const DESTINATION_ID = 430000000000000002n;

async function confirmedDestination(options: { source?: string; url?: string } = {}) {
	const url = options.url ?? "https://x-com.email/";
	const domain = new URL(url).hostname;
	await SubmissionsEntity.create({
		id: PARENT_ID,
		kind: "website",
		data: { kind: "website", website: { url: EMAIL_LINK_HOPS[0]!.url, navigationHops: EMAIL_LINK_HOPS, redirectSubmissionId: DESTINATION_ID.toString() } },
		dedupeKey: "website-tr.slicksalon.com",
		status: "redirected",
	});
	await SubmissionsEntity.create({
		id: DESTINATION_ID,
		kind: "website",
		data: { kind: "website", website: { url } },
		dedupeKey: `website-${domain}`,
		status: "reported",
		source: options.source ?? `redirect:${PARENT_ID.toString()}`,
	});
	const request = await validateAbuseReportRequest({
		targets: [domain],
		allegationCategory: "phishing",
		description: "Confirmed credential phishing.",
		observedUrls: [{ target: domain, urls: [url] }],
	});
	return AbuseRepository.createReport({ request, reporter: { reporterCountry: "CH" }, submissionId: DESTINATION_ID });
}

const watchJobs = async () => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "watch_redirector")).all();

describe("starting a redirector watch", () => {
	useTemporaryDatabase();

	test("watches the redirector a confirmed destination was reached through, once", async () => {
		const report = await confirmedDestination();
		const now = new Date("2026-11-11T12:00:00Z");
		await enqueueRedirectorWatch(report.reportId, DESTINATION_ID, now);
		await enqueueRedirectorWatch(report.reportId, DESTINATION_ID, now);
		const jobs = await watchJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			reportId: report.reportId,
			status: "queued",
			dedupeKey: `watch-redirector:${ROTATOR}`,
			nextAttemptAt: new Date(now.getTime() + REDIRECTOR_WATCH_INTERVAL_MS),
			payload: { url: ROTATOR, sites: ["x-com.email"], checks: 0, misses: 0, lastNewAt: now.toISOString() },
		});
	});

	test("watches nothing for a case submitted directly or reached by a link the capture followed", async () => {
		const direct = await confirmedDestination({ source: "https://x-com.email/" });
		await enqueueRedirectorWatch(direct.reportId, DESTINATION_ID);
		expect(await watchJobs()).toEqual([]);
	});
});

const VISIT_DESTINATION = "https://new-kit.example/";

/**
 * The full analysis of a redirector visit, as the browser would end it: handed
 * off to a destination case, failed to reach the redirector, or analyzed the
 * redirector's own page.
 */
function browser(outcome: { handOffTo?: string; status?: "failed" | "invalid" | "reported" }) {
	const visits: AnalyzeWebsiteOptions[] = [];
	const analyzeWebsite = async (options: AnalyzeWebsiteOptions) => {
		visits.push(options);
		if (outcome.handOffTo) {
			const destinationId = await SubmissionsEntity.create({
				kind: "website",
				data: { kind: "website", website: { url: outcome.handOffTo } },
				dedupeKey: `website-${new URL(outcome.handOffTo).hostname}`,
				status: "running",
				source: `redirect:${options.submissionId.toString()}`,
			});
			await SubmissionsEntity.update(options.submissionId, { status: "redirected", data: { kind: "website", website: { url: options.url, redirectSubmissionId: destinationId.toString() } } });
		} else {
			await SubmissionsEntity.update(options.submissionId, { status: outcome.status ?? "invalid" });
		}
		return options.submissionId;
	};
	return { analyzeWebsite, visits };
}

async function watchJob(reportId: bigint, state: Partial<RedirectorWatchState> = {}): Promise<AbuseJob> {
	return AbuseRepository.enqueueJob({
		jobType: "watch_redirector",
		reportId,
		payload: { url: ROTATOR, sites: ["x-com.email"], checks: 0, misses: 0, lastNewAt: "2026-11-11T12:00:00.000Z", ...state },
		dedupeKey: `watch-redirector:${ROTATOR}`,
	});
}

const DAY = 24 * 60 * 60_000;
const CHECKED_AT = new Date("2026-11-12T12:00:00Z");
const checkFinds = (check: RedirectorCheck) => async () => check;

async function successor(job: AbuseJob) {
	const queued = (await watchJobs()).filter((candidate) => candidate.id !== job.id);
	expect(queued.length).toBeLessThanOrEqual(1);
	return queued[0];
}

async function lastEvent(reportId: bigint) {
	const events = (await AbuseRepository.listEvents(reportId)).filter(({ eventType }) => eventType === "redirector_watch.checked");
	return events.at(-1)?.data;
}

describe("a daily redirector check", () => {
	useTemporaryDatabase();

	test("checks cheaply and queues the next day's check while the redirector leads to a known host", async () => {
		const report = await confirmedDestination();
		const job = await watchJob(report.reportId);
		const { analyzeWebsite, visits } = browser({});
		await watchRedirector({ job }, { checkRedirector: checkFinds({ kind: "destination", url: "https://x-com.email/", urls: [ROTATOR, "https://x-com.email/"] }), analyzeWebsite, now: () => CHECKED_AT });

		expect(visits).toEqual([]);
		expect(await successor(job)).toMatchObject({
			status: "queued",
			dedupeKey: `watch-redirector:${ROTATOR}`,
			nextAttemptAt: new Date(CHECKED_AT.getTime() + DAY),
			payload: { url: ROTATOR, sites: ["x-com.email"], checks: 1, misses: 0, lastNewAt: "2026-11-11T12:00:00.000Z" },
		});
		expect(await lastEvent(report.reportId)).toEqual({ url: ROTATOR, check: { kind: "destination", url: "https://x-com.email/" }, newSites: [], checks: 1 });
	});

	test("visits in the browser as a dated case of its own when the redirector leads somewhere new", async () => {
		const report = await confirmedDestination();
		const job = await watchJob(report.reportId);
		const { analyzeWebsite, visits } = browser({ handOffTo: "https://assistdeparments-x.com/" });
		await watchRedirector({ job }, { checkRedirector: checkFinds({ kind: "destination", url: "https://assistdeparments-x.com/", urls: [] }), analyzeWebsite, now: () => CHECKED_AT });

		expect(visits).toHaveLength(1);
		expect(visits[0]).toMatchObject({ url: ROTATOR, reporterCountry: "CH" });
		expect(visits[0]).not.toHaveProperty("visit");
		const visitCase = await SubmissionsEntity.get(visits[0]!.submissionId);
		expect(visitCase).toMatchObject({ status: "redirected", source: `redirector-watch:${report.reportId.toString()}`, dedupeKey: `website-openanonymity.chat#watch-${job.id.toString()}` });
		expect(await successor(job)).toMatchObject({ payload: { sites: ["x-com.email", "assistdeparments-x.com"], checks: 1, misses: 0, lastNewAt: CHECKED_AT.toISOString() } });
		expect(await lastEvent(report.reportId)).toEqual({
			url: ROTATOR,
			check: { kind: "destination", url: "https://assistdeparments-x.com/" },
			visit: { submissionId: visits[0]!.submissionId.toString(), status: "redirected", destination: "https://assistdeparments-x.com/" },
			newSites: ["assistdeparments-x.com"],
			checks: 1,
		});
	});

	test("records what the browser reached when a cloaker shows the plain client nothing", async () => {
		const report = await confirmedDestination();
		const job = await watchJob(report.reportId, { checks: 3 });
		const { analyzeWebsite } = browser({ handOffTo: VISIT_DESTINATION });
		await watchRedirector({ job }, { checkRedirector: checkFinds({ kind: "stays", urls: [ROTATOR] }), analyzeWebsite, now: () => CHECKED_AT });
		expect(await successor(job)).toMatchObject({ payload: { sites: ["x-com.email", "new-kit.example"], checks: 4, lastNewAt: CHECKED_AT.toISOString() } });
	});

	test("lets the browser look every seventh check even when the plain client sees a known host", async () => {
		const report = await confirmedDestination();
		const job = await watchJob(report.reportId, { checks: 6 });
		const { analyzeWebsite, visits } = browser({ handOffTo: VISIT_DESTINATION });
		await watchRedirector({ job }, { checkRedirector: checkFinds({ kind: "destination", url: "https://x-com.email/", urls: [] }), analyzeWebsite, now: () => CHECKED_AT });
		expect(visits).toHaveLength(1);
		expect(await successor(job)).toMatchObject({ payload: { sites: ["x-com.email", "new-kit.example"], checks: 7 } });
	});

	test("counts a day on which neither route reached the redirector, and ends the watch after three", async () => {
		const report = await confirmedDestination();
		const unreachable = checkFinds({ kind: "unreachable", reason: "queryA ENOTFOUND openanonymity.chat", urls: [] });
		const { analyzeWebsite, visits } = browser({ status: "failed" });
		const second = await watchJob(report.reportId, { checks: 4, misses: 1 });
		await watchRedirector({ job: second }, { checkRedirector: unreachable, analyzeWebsite, now: () => CHECKED_AT });
		const third = (await successor(second))!;
		expect(third.payload).toMatchObject({ misses: 2, checks: 5 });

		await AbuseRepository.claimNextJob("test", 60_000, { jobTypes: ["watch_redirector"] });
		await watchRedirector({ job: third }, { checkRedirector: unreachable, analyzeWebsite, now: () => new Date(CHECKED_AT.getTime() + DAY) });
		expect(visits).toHaveLength(2);
		// The third check queued no fourth.
		expect((await watchJobs()).map(({ id }) => id).sort()).toEqual([second.id, third.id].sort());
		expect(await lastEvent(report.reportId)).toMatchObject({ check: { kind: "unreachable" }, visit: { status: "failed" }, ended: "nothing reached the redirector on 3 daily checks in a row" });
	});

	test("does not count a day on which only the browser reached the redirector", async () => {
		// A cloaker that refuses the server's own address answers the browser's routes.
		const report = await confirmedDestination();
		const job = await watchJob(report.reportId, { misses: 2 });
		const { analyzeWebsite } = browser({ status: "invalid" });
		await watchRedirector({ job }, { checkRedirector: checkFinds({ kind: "unreachable", reason: "HTTP 403", urls: [] }), analyzeWebsite, now: () => CHECKED_AT });
		expect(await successor(job)).toMatchObject({ payload: { misses: 0, sites: ["x-com.email"] } });
	});

	test("ends a watch whose redirector led nowhere new for thirty days", async () => {
		const report = await confirmedDestination();
		const job = await watchJob(report.reportId, { checks: 29, lastNewAt: new Date(CHECKED_AT.getTime() - 30 * DAY).toISOString() });
		const { analyzeWebsite } = browser({});
		await watchRedirector({ job }, { checkRedirector: checkFinds({ kind: "destination", url: "https://x-com.email/", urls: [] }), analyzeWebsite, now: () => CHECKED_AT });
		expect(await successor(job)).toBeUndefined();
		expect(await lastEvent(report.reportId)).toMatchObject({ ended: "the redirector led nowhere new in 30 days" });
	});

	test("a retried check reads the case its first attempt opened instead of visiting again", async () => {
		const report = await confirmedDestination();
		const job = await watchJob(report.reportId);
		const { analyzeWebsite, visits } = browser({ handOffTo: "https://assistdeparments-x.com/" });
		const check = checkFinds({ kind: "destination", url: "https://assistdeparments-x.com/", urls: [] });
		await watchRedirector({ job }, { checkRedirector: check, analyzeWebsite, now: () => CHECKED_AT });
		await (await getDb()).delete(abuseJobs).where(and(eq(abuseJobs.jobType, "watch_redirector"), eq(abuseJobs.status, "queued"))).run();
		await watchRedirector({ job: { ...job, status: "running" } }, { checkRedirector: check, analyzeWebsite, now: () => CHECKED_AT });
		expect(visits).toHaveLength(1);
		expect(await lastEvent(report.reportId)).toMatchObject({ visit: { status: "redirected", destination: "https://assistdeparments-x.com/" } });
		const visitCases = (await getDb()).select().from(submissions).where(eq(submissions.dedupeKey, `website-openanonymity.chat#watch-${job.id.toString()}`)).all();
		expect(visitCases).toHaveLength(1);
	});

	test("a report for a host the watch found adds no second watch", async () => {
		const report = await confirmedDestination();
		const job = await watchJob(report.reportId);
		await AbuseRepository.claimNextJob("test", 60_000, { jobTypes: ["watch_redirector"] });
		// The destination reported while the watch runs, then once its next check is queued.
		await enqueueRedirectorWatch(report.reportId, DESTINATION_ID);
		const { analyzeWebsite } = browser({ handOffTo: "https://assistdeparments-x.com/" });
		await watchRedirector({ job }, { checkRedirector: checkFinds({ kind: "destination", url: "https://assistdeparments-x.com/", urls: [] }), analyzeWebsite, now: () => CHECKED_AT });
		await enqueueRedirectorWatch(report.reportId, DESTINATION_ID);
		expect((await watchJobs()).map(({ status }) => status).sort()).toEqual(["queued", "running"]);
	});

	test("refuses a job without a valid state", async () => {
		const report = await confirmedDestination();
		const job = await AbuseRepository.enqueueJob({ jobType: "watch_redirector", reportId: report.reportId, payload: { url: ROTATOR, sites: [] } });
		await expect(watchRedirector({ job }, { checkRedirector: async () => { throw new Error("must not check"); } })).rejects.toThrow("invalid state");
	});
});

describe("separate visits of one site", () => {
	useTemporaryDatabase();

	test("are cases on the site's domain next to its first case", async () => {
		await SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url: ROTATOR } }, dedupeKey: "website-openanonymity.chat" });
		await SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url: ROTATOR } }, dedupeKey: "website-openanonymity.chat#watch-1" });
		await SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url: "https://cdn.openanonymity.chat/" } }, dedupeKey: "website-cdn.openanonymity.chat#watch-2" });
		await SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url: "https://notopenanonymity.chat/" } }, dedupeKey: "website-notopenanonymity.chat#watch-3" });
		expect((await SubmissionsEntity.listWebsitesOnDomain("openanonymity.chat")).map(({ dedupeKey }) => dedupeKey).sort()).toEqual([
			"website-cdn.openanonymity.chat#watch-2",
			"website-openanonymity.chat",
			"website-openanonymity.chat#watch-1",
		]);
	});
});
