import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db";
import { SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { AbuseRepository } from "../abuse/repository";
import { abuseJobs, type AbuseJob } from "../abuse/schema";
import type { WebsiteKitResource, WebsiteSiteAssessment } from "../website_types";
import { armCampaignKitSearch, searchableKitFingerprints, searchCampaignKits } from "./kit_search";
import { linkSubmissionToCampaign, type LinkDependencies } from "./link";
import { CampaignRepository } from "./repository";

useTemporaryDatabase();

const KIT = "a".repeat(64);
const SHARED = "b".repeat(64);
const SIBLING_ONLY = "c".repeat(64);
const STYLE = "d".repeat(64);
const PHISHING: WebsiteSiteAssessment[] = [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign in" }];

const script = (host: string, sha256: string, size = 40_000): WebsiteKitResource => ({ url: `https://${host}/app.js`, mimeType: "application/javascript", size, sha256 });

const linking: LinkDependencies = {
	loadBackends: async () => [],
	loadPageTexts: async () => [],
	libraryFor: async () => undefined,
	loadPopularDomains: async () => new Set(),
	loadPageDocument: async () => undefined,
	saveThumbnail: async () => undefined,
} as LinkDependencies;

/** A reported site with its report, linked into its campaign. */
async function site(id: bigint, host: string, kitResources: WebsiteKitResource[], source = `https://${host}/`) {
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: `https://${host}/`, kitResources, siteAssessments: PHISHING } },
		dedupeKey: `website-${host}`,
		status: "reported",
		source,
	});
	const request = await validateAbuseReportRequest({ targets: [host], allegationCategory: "phishing", description: "Confirmed credential phishing.", observedUrls: [{ target: host, urls: [`https://${host}/`] }] });
	const report = await AbuseRepository.createReport({ request, reporter: { reporterCountry: "DE" }, submissionId: id });
	const campaignId = (await linkSubmissionToCampaign(id, linking))!;
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

const searchJobs = async () => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "search_campaign_kits")).all();
const queuedSearch = async (): Promise<AbuseJob> => (await searchJobs()).find((job) => job.status === "queued")!;
const finish = async (job: AbuseJob) => (await getDb()).update(abuseJobs).set({ status: "completed" }).where(eq(abuseJobs.id, job.id)).run();
const analysisJobs = async () => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "analyze_kit_sibling")).all();
const searchEvents = async (reportId: bigint) => (await AbuseRepository.listEvents(reportId)).filter(({ eventType }) => eventType === "kit_siblings.discovered").map(({ data }) => data);

describe("a campaign's kit search", () => {
	test("searches its sites' own code: an original report's file or one two sites share, never a file only a found sibling holds", async () => {
		const original = await site(1n, "seed-kit-test.com", [script("seed-kit-test.com", KIT), script("seed-kit-test.com", SHARED, 30_000), { url: "https://seed-kit-test.com/s.css", mimeType: "text/css", size: 9_000, sha256: STYLE }]);
		// Found by an earlier search: its own extra file is not searched, the file it shares with the seed is.
		await site(2n, "found-sibling-test.com", [script("found-sibling-test.com", SHARED, 30_000), script("found-sibling-test.com", SIBLING_ONLY, 50_000)], `kit-sibling:1:${original.reportId}`);
		const campaignId = (await CampaignRepository.currentCampaignId(original.campaignId))!;
		expect(await CampaignRepository.campaignForSubmission(2n)).toBe(campaignId);
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
			{ payload: { url: "https://new-one-test.com/login" }, reportId: original.reportId },
			{ payload: { url: "https://new-two-test.com/login" }, reportId: original.reportId },
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
		if (stored.kind === "website") await SubmissionsEntity.update(41n, { data: { kind: "website", website: { ...stored.website, archiveUrl: "https://landing-quota-test.com/login", navigationHops: [{ index: 0, url: "https://quota-test.com/", hostname: "quota-test.com", status: 302, redirectTo: "https://landing-quota-test.com/login", contentCaptured: false }, { index: 1, url: "https://landing-quota-test.com/login", hostname: "landing-quota-test.com", status: 200, contentCaptured: true }] } } });
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
		expect((await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.jobType, "search_campaign_kits"), eq(abuseJobs.reportId, plain.reportId))).all()).toEqual([]);
	});
});
