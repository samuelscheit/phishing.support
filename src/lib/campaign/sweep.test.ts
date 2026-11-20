import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../db";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { AbuseRepository } from "../abuse/repository";
import { abuseJobs } from "../abuse/schema";
import type { WebsiteKitResource } from "../website/types";
import type { LinkDependencies } from "./link";
import { CampaignRepository } from "./repository";
import { CAMPAIGN_RULES_VERSION, enqueueCampaignSweep, enqueueRulesSweep, linkSiteToCampaign } from "./sweep";

useTemporaryDatabase();

const KIT = "e".repeat(64);
const linking = {
	loadBackends: async () => [],
	loadPageTexts: async () => [{ name: "website.mhtml", text: "Sign in to your mailbox to read the document waiting for you from the shared drive today." }],
	libraryFor: async () => undefined,
	isPlatformHost: async () => false,
	loadPopularDomains: async () => new Set<string>(),
	loadPageFingerprints: async () => ({}),
	saveThumbnail: async () => undefined,
} as LinkDependencies;

async function site(id: bigint, host: string, options: { status?: "reported" | "invalid"; report?: boolean; kitResources?: WebsiteKitResource[] } = {}) {
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: `https://${host}/`, siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign in" }], ...(options.kitResources ? { kitResources: options.kitResources } : {}) } },
		dedupeKey: `website-${host}`,
		status: options.status ?? "reported",
	});
	if (options.report === false) return undefined;
	const request = await validateAbuseReportRequest({ targets: [host], allegationCategory: "phishing", description: "Confirmed credential phishing.", observedUrls: [{ target: host, urls: [`https://${host}/`] }] });
	return (await AbuseRepository.createReport({ request, reporter: {}, submissionId: id })).reportId;
}

const jobs = async (jobType: "link_campaign" | "describe_campaign" | "search_campaign_kits") => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, jobType)).all();

describe("the campaign sweep", () => {
	test("queues one link job per confirmed site with a report, spaced apart, once per label", async () => {
		await site(1n, "first-sweep-test.com");
		await site(2n, "second-sweep-test.com");
		await site(3n, "no-report-sweep-test.com", { report: false });
		await site(4n, "invalid-sweep-test.com", { status: "invalid" });
		const now = new Date("2026-11-20T00:00:00Z");
		expect(await enqueueCampaignSweep("rules-v1", now)).toBe(2);
		expect(await enqueueCampaignSweep("rules-v1", now)).toBe(2);
		const queued = await jobs("link_campaign");
		expect(queued.map(({ payload, nextAttemptAt }) => ({ payload, at: nextAttemptAt.toISOString() }))).toEqual([
			{ payload: { submissionId: "1" }, at: "2026-11-20T00:00:00.000Z" },
			{ payload: { submissionId: "2" }, at: "2026-11-20T00:00:20.000Z" },
		]);
		// Another label, such as an operator's sweep, queues them again.
		await enqueueCampaignSweep("manual-2026-11-21", now);
		expect(await jobs("link_campaign")).toHaveLength(4);
	});

	test("a rules sweep drops the jobs an older rules sweep still has waiting, never the ones that ran or a site's own link", async () => {
		await site(1n, "first-rules-test.com");
		await site(2n, "second-rules-test.com");
		const now = new Date("2026-11-20T00:00:00Z");
		await enqueueCampaignSweep(`rules-v${CAMPAIGN_RULES_VERSION - 2}`, now);
		await enqueueCampaignSweep(`rules-v${CAMPAIGN_RULES_VERSION - 1}`, now);
		await enqueueCampaignSweep("manual-2026-11-19", now);
		const reportId = (await AbuseRepository.getReportForSubmission(1n))!.id;
		await AbuseRepository.enqueueJob({ jobType: "link_campaign", reportId, payload: { submissionId: "1" }, dedupeKey: "campaign-link:1" });
		// One job of the oldest sweep already ran.
		const db = await getDb();
		const [ran] = (await jobs("link_campaign")).filter((job) => job.dedupeKey === `campaign-link:rules-v${CAMPAIGN_RULES_VERSION - 2}:1`);
		db.update(abuseJobs).set({ status: "completed" }).where(eq(abuseJobs.id, ran!.id)).run();

		expect(await enqueueRulesSweep()).toBe(2);
		expect((await jobs("link_campaign")).map((job) => `${job.dedupeKey} ${job.status}`).sort()).toEqual([
			"campaign-link:1 queued",
			"campaign-link:manual-2026-11-19:1 queued",
			"campaign-link:manual-2026-11-19:2 queued",
			`campaign-link:rules-v${CAMPAIGN_RULES_VERSION - 2}:1 completed`,
			`campaign-link:rules-v${CAMPAIGN_RULES_VERSION}:1 queued`,
			`campaign-link:rules-v${CAMPAIGN_RULES_VERSION}:2 queued`,
		]);
	});

	test("a site is linked, described and searched; urlscan failing is recorded and leaves it linked, urlscan busy puts the backfill off", async () => {
		const reportId = (await site(11n, "kit-sweep-test.com", { kitResources: [{ url: "https://kit-sweep-test.com/app.js", mimeType: "application/javascript", size: 40_000, sha256: KIT }] }))!;
		const campaignId = await linkSiteToCampaign({ submissionId: 11n, reportId }, { ...linking, fetch: async () => { throw new Error("no urlscan call expected"); } });
		expect(campaignId).toBe((await CampaignRepository.campaignForSubmission(11n))!);
		expect((await jobs("describe_campaign")).map(({ payload }) => payload)).toEqual([{ campaignId: campaignId!.toString() }]);
		expect((await jobs("search_campaign_kits")).map(({ payload }) => payload?.campaignId)).toEqual([campaignId!.toString()]);

		// An old capture without files: urlscan answers garbage, the site is linked by what it has.
		const oldReport = (await site(12n, "old-sweep-test.com"))!;
		const broken = async () => new Response("not json", { status: 200 });
		expect(await linkSiteToCampaign({ submissionId: 12n, reportId: oldReport }, { ...linking, apiKey: "test", fetch: broken })).toBeDefined();
		expect((await AbuseRepository.listEvents(oldReport)).filter(({ eventType }) => eventType === "kit_backfill.checked").map(({ data }) => data.kind)).toEqual(["failed"]);

		// urlscan's daily quota used up: the site is linked now, its backfill runs when urlscan resets.
		const busyReport = (await site(13n, "busy-sweep-test.com"))!;
		const busy = async () => new Response("slow down", { status: 429, headers: { "X-Rate-Limit-Reset-After": "7200" } });
		const before = Date.now();
		expect(await linkSiteToCampaign({ submissionId: 13n, reportId: busyReport }, { ...linking, apiKey: "test", fetch: busy })).toBe((await CampaignRepository.campaignForSubmission(13n))!);
		const deferred = (await AbuseRepository.listEvents(busyReport)).find(({ eventType }) => eventType === "kit_backfill.checked")!.data;
		expect(deferred).toMatchObject({ kind: "deferred" });
		const retry = (await jobs("link_campaign")).find(({ dedupeKey }) => dedupeKey === "campaign-link:backfill:13")!;
		expect(retry.payload).toEqual({ submissionId: "13" });
		expect(retry.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(7_200_000);
		// Nothing was concluded about urlscan's scans of the site.
		const stored = (await SubmissionsEntity.get(13n))!.data;
		expect(stored.kind === "website" && stored.website.urlscanKit).toBeUndefined();
	});
});
