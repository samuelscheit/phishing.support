import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { AbuseRepository } from "../abuse/repository";
import { jobs, type Job } from "../abuse/schema";
import type { WebsiteKitResource, WebsiteSiteAssessment } from "../website/types";
import { analyzeKitSibling } from "../abuse/origin/kit_job";
import { websiteSubmissionDedupeKey } from "../submissions/website";
import { runQueuedVisits } from "../website/visit_queue/test_helpers";
import { armCampaignKitSearch, searchableKitFingerprints, searchCampaignKits } from "./kit_search";
import { linkSiteMember, type LinkDependencies } from "./link";
import { CampaignRepository } from "./repository";

useTemporaryDatabase();

const KIT = "a".repeat(64);
const SHARED = "b".repeat(64);
const SIBLING_ONLY = "c".repeat(64);
const STYLE = "d".repeat(64);
const PLATFORM_FILE = "e".repeat(64);
const PLATFORM_HOST = "assets.builder-test.org";
const PHISHING: WebsiteSiteAssessment[] = [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign in" }];

const script = (host: string, sha256: string, size = 40_000): WebsiteKitResource => ({ url: `https://${host}/app.js`, mimeType: "application/javascript", size, sha256 });

const linking: LinkDependencies = {
	loadBackends: async () => [],
	loadPageTexts: async () => [],
	libraryFor: async () => undefined,
	isPlatformHost: async (host: string) => host === PLATFORM_HOST,
	loadPopularDomains: async () => new Set(),
	loadPageFingerprints: async () => ({}),
	saveThumbnail: async () => undefined,
} as LinkDependencies;

/** A reported site with its report, linked into its campaign. */
async function site(id: bigint, host: string, kitResources: WebsiteKitResource[], source = `https://${host}/`) {
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: `https://${host}/`, kitResources, routes: [{ hops: [], siteAssessments: PHISHING }] } },
		dedupeKey: `website-${host}`,
		status: "reported",
		source,
	});
	const request = await validateAbuseReportRequest({ targets: [host], allegationCategory: "phishing", description: "Confirmed credential phishing.", observedUrls: [{ target: host, urls: [`https://${host}/`] }] });
	const report = await AbuseRepository.createReport({ request, reporter: { reporterCountry: "DE" }, submissionId: id });
	const campaignId = (await linkSiteMember({ submissionId: id, reportId: report.reportId, site: host }, linking))!;
	return { reportId: report.reportId, campaignId };
}

/** urlscan's search answering per hash with the domains holding it. */
function urlscan(domainsByHash: Record<string, string[]>) {
	const queries: string[] = [];
	const fetch = async (url: string) => {
		const query = new URL(url).searchParams.get("q")!;
		queries.push(query);
		const domains = domainsByHash[query.match(/^hash:([a-f0-9]{64})/)?.[1] ?? ""] ?? [];
		return new Response(JSON.stringify({ results: domains.map((domain) => ({ page: { domain, url: `https://${domain}/login` } })) }), { status: 200 });
	};
	return { fetch, queries };
}

/** No candidate is a top-ranked site; the real Tranco list is never downloaded in a test. */
const noPopularSites = async () => new Set<string>();

const searchJobs = async () => (await getDb()).select().from(jobs).where(eq(jobs.jobType, "search_campaign_kits")).all();
const queuedSearch = async (): Promise<Job> => (await searchJobs()).find((job) => job.status === "queued")!;
const finish = async (job: Job) => (await getDb()).update(jobs).set({ status: "completed" }).where(eq(jobs.id, job.id)).run();
const analysisJobs = async () => (await getDb()).select().from(jobs).where(eq(jobs.jobType, "analyze_kit_sibling")).all();
const searchEvents = async (reportId: bigint) => (await AbuseRepository.listEvents(reportId)).filter(({ eventType }) => eventType === "kit_siblings.discovered").map(({ data }) => data);

describe("a campaign's kit search", () => {
	test("searches its sites' own code: an original report's file or one two sites share, never a file only a found sibling holds", async () => {
		const original = await site(1n, "seed-kit-test.com", [script("seed-kit-test.com", KIT), script("seed-kit-test.com", SHARED, 30_000), { url: "https://seed-kit-test.com/s.css", mimeType: "text/css", size: 9_000, sha256: STYLE }]);
		// Found by an earlier search: its own extra file is not searched, the file it shares with the seed is.
		const sibling = await site(2n, "found-sibling-test.com", [script("found-sibling-test.com", SHARED, 30_000), script("found-sibling-test.com", SIBLING_ONLY, 50_000)], `kit-sibling:1:${original.reportId}`);
		const campaignId = (await CampaignRepository.currentCampaignId(original.campaignId))!;
		expect(sibling.campaignId).toBe(campaignId);
		const searched = await searchableKitFingerprints(await CampaignRepository.listMembers(campaignId));
		expect(searched.map(({ sha256, kind }) => ({ sha256, kind }))).toEqual([{ sha256: KIT, kind: "script" }, { sha256: SHARED, kind: "script" }]);
	});

	test("finds new domains, analyzes each one once as the seed report's sibling, and runs again tomorrow", async () => {
		const original = await site(11n, "kit-one-test.com", [script("kit-one-test.com", KIT)]);
		// A domain with a case already is never opened again.
		await SubmissionsEntity.create({ id: 19n, kind: "website", data: { kind: "website", website: { url: "https://known-test.com/" } }, dedupeKey: "website-known-test.com", status: "invalid" });
		const now = new Date("2026-11-20T08:00:00Z");
		expect(await armCampaignKitSearch(original.campaignId, now)).toBe(true);
		expect(await armCampaignKitSearch(original.campaignId, now)).toBe(true);
		expect(await searchJobs()).toHaveLength(1);
		const job = await queuedSearch();
		expect(job.reportId).toBe(original.reportId);

		const { fetch, queries } = urlscan({ [KIT]: ["kit-one-test.com", "known-test.com", "new-one-test.com", "new-two-test.com"] });
		await searchCampaignKits({ job }, { fetch, apiKey: "test", loadPopularDomains: noPopularSites, now: () => now });
		expect(queries).toEqual([`hash:${KIT} AND date:>now-90d`]);
		const analyses = await analysisJobs();
		expect(analyses.map(({ payload, reportId }) => ({ payload, reportId }))).toEqual([
			{ payload: { url: "https://new-one-test.com/login", hashes: [KIT] }, reportId: original.reportId },
			{ payload: { url: "https://new-two-test.com/login", hashes: [KIT] }, reportId: original.reportId },
		]);
		expect(analyses[1]!.nextAttemptAt.getTime() - analyses[0]!.nextAttemptAt.getTime()).toBe(30_000);
		expect(await searchEvents(original.reportId)).toEqual([{
			campaignId: original.campaignId.toString(),
			fingerprints: [{ sha256: KIT, url: "https://kit-one-test.com/app.js", size: 40_000 }],
			candidates: ["new-one-test.com", "new-two-test.com"],
			errors: [],
			checks: 1,
		}]);

		// The next run is due a day later and remembers that something new was found now.
		await finish(job);
		const next = await queuedSearch();
		expect(next.nextAttemptAt.toISOString()).toBe("2026-11-21T08:00:00.000Z");
		expect(next.payload).toEqual({ campaignId: original.campaignId.toString(), checks: 1, lastNewAt: now.toISOString() });

		// Found again later, the same domains are not analyzed twice.
		await searchCampaignKits({ job: next }, { fetch, apiKey: "test", loadPopularDomains: noPopularSites, now: () => new Date("2026-11-21T08:00:00Z") });
		expect(await analysisJobs()).toHaveLength(2);
	});

	test("urlscan's quota used up puts the run off until it resets, with nothing concluded; a site's other hosts are never candidates", async () => {
		const original = await site(41n, "quota-test.com", [script("quota-test.com", KIT)]);
		// The member's submitted address led to another host, where its page was captured.
		const stored = (await SubmissionsEntity.get(41n))!.data;
		if (stored.kind === "website") await SubmissionsEntity.update(41n, { data: { kind: "website", website: { ...stored.website, archiveUrl: "https://landing-quota-test.com/login", routes: [{ hops: [{ index: 0, url: "https://quota-test.com/", hostname: "quota-test.com", status: 302, redirectTo: "https://landing-quota-test.com/login", contentCaptured: false }, { index: 1, url: "https://landing-quota-test.com/login", hostname: "landing-quota-test.com", status: 200, contentCaptured: true }], analyzedHopIndex: 1, siteAssessments: PHISHING }] } } });
		const now = new Date("2026-11-20T08:00:00Z");
		await armCampaignKitSearch(original.campaignId, now);
		const job = await queuedSearch();
		const busy = async () => new Response("quota", { status: 429, headers: { "X-Rate-Limit-Reset-After": "3600" } });
		await searchCampaignKits({ job }, { fetch: busy, apiKey: "test", loadPopularDomains: noPopularSites, now: () => now });
		await finish(job);
		const next = await queuedSearch();
		expect(next.nextAttemptAt.toISOString()).toBe("2026-11-20T09:00:00.000Z");
		expect(next.payload).toEqual(job.payload);
		expect((await searchEvents(original.reportId)).at(-1)).toMatchObject({ deferred: expect.stringContaining("429"), retryAt: "2026-11-20T09:00:00.000Z" });

		const { fetch } = urlscan({ [KIT]: ["quota-test.com", "landing-quota-test.com"] });
		await searchCampaignKits({ job: next }, { fetch, apiKey: "test", loadPopularDomains: noPopularSites, now: () => new Date("2026-11-20T09:00:00Z") });
		expect((await analysisJobs()).filter(({ reportId }) => reportId === original.reportId)).toEqual([]);
	});

	test("a site builder's file the seed was built with finds only the builder's other sites on the seed's own domain", async () => {
		const original = await site(61n, "outlook.builder-test.online", [script(PLATFORM_HOST, PLATFORM_FILE)]);
		expect(await armCampaignKitSearch(original.campaignId)).toBe(true);
		const { fetch, queries } = urlscan({ [PLATFORM_FILE]: ["outlook.builder-test.online", "mail.builder-test.online", "pizzeria-customer-test.it"] });
		await searchCampaignKits({ job: await queuedSearch() }, { fetch, apiKey: "test", loadPopularDomains: noPopularSites });
		expect(queries).toEqual([`hash:${PLATFORM_FILE} AND page.apexDomain:builder-test.online AND date:>now-90d`]);
		expect((await analysisJobs()).map(({ payload }) => payload)).toEqual([{ url: "https://mail.builder-test.online/login", hashes: [PLATFORM_FILE] }]);
		expect((await searchEvents(original.reportId))[0]).toMatchObject({ fingerprints: [{ sha256: PLATFORM_FILE, scope: "builder-test.online" }] });
	});

	test("a kit file whose found sites were all harmless is retired: never searched again, its queued sites never opened; one confirmed site keeps it", async () => {
		const original = await site(81n, "retire-test.com", [script("retire-test.com", KIT)]);
		const found = async (index: number, status: "invalid" | "reported" | "failed") => {
			const url = `https://found-${index}-retire-test.net/`;
			await SubmissionsEntity.create({ id: BigInt(9_000 + index), kind: "website", data: { kind: "website", website: { url } }, dedupeKey: websiteSubmissionDedupeKey(url), status });
			await AbuseRepository.enqueueJobOnce({ jobType: "analyze_kit_sibling", reportId: original.reportId, payload: { url, hashes: [KIT] }, dedupeKey: `analyze-kit-sibling:${index}` });
		};
		const members = () => CampaignRepository.listMembers(original.campaignId);
		// Sites that could not be opened say nothing about the file.
		for (let index = 0; index < 7; index += 1) await found(index, "invalid");
		for (let index = 7; index < 12; index += 1) await found(index, "failed");
		expect((await searchableKitFingerprints(await members())).map(({ sha256 }) => sha256)).toEqual([KIT]);
		await found(12, "invalid");
		expect(await searchableKitFingerprints(await members())).toEqual([]);
		expect(await armCampaignKitSearch(original.campaignId)).toBe(false);

		// A site queued before the file was retired is not opened, and the case records why.
		let opened = false;
		const skipped = await analyzeKitSibling({ reportId: original.reportId, url: "https://queued-retire-test.net/", hashes: [KIT] });
		await runQueuedVisits(async () => { opened = true; return 1n; });
		expect({ skipped, opened }).toEqual({ skipped: undefined, opened: false });
		expect((await AbuseRepository.listEvents(original.reportId)).filter(({ eventType }) => eventType === "kit_siblings.skipped").map(({ data }) => data)).toEqual([{ url: "https://queued-retire-test.net/", retiredHashes: [KIT] }]);
		// Found through another, live file too, it is opened.
		await analyzeKitSibling({ reportId: original.reportId, url: "https://queued-retire-test.net/", hashes: [KIT, SHARED] });
		await runQueuedVisits(async () => { opened = true; return 1n; });
		expect(opened).toBe(true);

		await found(13, "reported");
		expect((await searchableKitFingerprints(await members())).map(({ sha256 }) => sha256)).toEqual([KIT]);
	});

	test("a search armed for a campaign that stopped growing counts as quiet since its newest site", async () => {
		const original = await site(51n, "old-campaign-test.com", [script("old-campaign-test.com", KIT)]);
		const joined = (await CampaignRepository.listMembers(original.campaignId))[0]!.createdAt;
		await armCampaignKitSearch(original.campaignId, new Date(joined.getTime() + 90 * 86_400_000));
		expect((await queuedSearch()).payload).toMatchObject({ lastNewAt: joined.toISOString() });
	});

	test("searches daily while new sites turn up, weekly once quiet, and stops after two quiet months", async () => {
		const original = await site(21n, "kit-two-test.com", [script("kit-two-test.com", KIT)]);
		const armedAt = new Date("2026-11-01T00:00:00Z");
		await armCampaignKitSearch(original.campaignId, armedAt);
		const { fetch } = urlscan({});
		const runAt = async (iso: string) => {
			const job = await queuedSearch();
			await searchCampaignKits({ job }, { fetch, apiKey: "test", loadPopularDomains: noPopularSites, now: () => new Date(iso) });
			await finish(job);
			return queuedSearch();
		};
		expect((await runAt("2026-11-10T00:00:00Z")).nextAttemptAt.toISOString()).toBe("2026-11-11T00:00:00.000Z");
		expect((await runAt("2026-11-20T00:00:00Z")).nextAttemptAt.toISOString()).toBe("2026-11-27T00:00:00.000Z");
		expect(await runAt("2027-01-01T00:00:00Z")).toBeUndefined();
		expect((await searchEvents(original.reportId)).at(-1)).toMatchObject({ ended: "nothing new in 60 days", checks: 3 });
		// A site that joins starts it again.
		expect(await armCampaignKitSearch(original.campaignId, new Date("2027-01-02T00:00:00Z"))).toBe(true);
	});

	test("a campaign merged into another ends its search and starts the other's; one without code is never searched", async () => {
		const older = await site(31n, "merge-one-test.com", [script("merge-one-test.com", KIT)]);
		const newer = await site(32n, "merge-two-test.com", [script("merge-two-test.com", SHARED)]);
		expect(newer.campaignId).not.toBe(older.campaignId);
		await armCampaignKitSearch(newer.campaignId);
		const job = await queuedSearch();
		// A site running both kits' code joins the two campaigns; the newer one is absorbed into the older.
		await site(33n, "merge-both-test.com", [script("merge-both-test.com", KIT), script("merge-both-test.com", SHARED, 30_000)]);
		expect(await CampaignRepository.currentCampaignId(newer.campaignId)).toBe(older.campaignId);
		await searchCampaignKits({ job }, { fetch: urlscan({}).fetch, apiKey: "test", loadPopularDomains: noPopularSites });
		expect((await searchEvents(newer.reportId)).at(-1)).toEqual({ campaignId: newer.campaignId.toString(), ended: `merged into campaign ${older.campaignId}` });
		await finish(job);
		expect((await queuedSearch()).payload).toMatchObject({ campaignId: older.campaignId.toString() });
		const plain = await site(34n, "no-code-test.com", []);
		expect(await armCampaignKitSearch(plain.campaignId)).toBe(false);
		expect((await getDb()).select().from(jobs).where(and(eq(jobs.jobType, "search_campaign_kits"), eq(jobs.reportId, plain.reportId))).all()).toEqual([]);
	});
});
