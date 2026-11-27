import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { BrowserUnavailableError } from "../../browser/fabric";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { jobs, type Job } from "../schema";
import { AbuseWorker } from "./";

useTemporaryDatabase();

describe("the worker's lanes", () => {
	test("a site just reported is linked into its campaign while a kit search and sibling analyses hold the discovery slot", async () => {
		// Production: a site reported at 14:13 stayed a campaign of one for hours, its link job queued behind 170 browser analyses of kit siblings.
		const request = await validateAbuseReportRequest({ targets: ["impresspaper.com"], allegationCategory: "phishing", description: "Confirmed credential phishing.", observedUrls: [{ target: "impresspaper.com", urls: ["https://impresspaper.com/invite.html"] }] });
		await SubmissionsEntity.create({ id: 1n, kind: "website", data: { kind: "website", website: { url: "https://impresspaper.com/invite.html" } }, dedupeKey: "lanes-site" });
		const { reportId } = await AbuseRepository.createReport({ request, reporter: {}, submissionId: 1n });
		const past = new Date(Date.now() - 60_000);
		for (const [index, jobType] of (["search_campaign_kits", "analyze_kit_sibling", "analyze_kit_sibling"] as const).entries()) {
			await AbuseRepository.enqueueJob({ jobType, reportId, payload: {}, dedupeKey: `discovery-${index}`, nextAttemptAt: past });
		}
		await AbuseRepository.enqueueJob({ jobType: "link_campaign", reportId, payload: { submissionId: "1" }, dedupeKey: "campaign-link:1" });

		const started: string[] = [];
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		let linked!: () => void;
		const linkedSite = new Promise<void>((resolve) => { linked = resolve; });
		const worker = new AbuseWorker({
			pollMs: 5,
			processJob: async (job: Job) => {
				started.push(job.jobType);
				if (job.jobType === "link_campaign") linked();
				else if (job.jobType === "search_campaign_kits" || job.jobType === "analyze_kit_sibling") await blocked;
			},
		});
		await worker.start();
		try {
			await Promise.race([linkedSite, new Promise((_, reject) => setTimeout(() => reject(new Error("the link job waited behind discovery")), 2_000))]);
			// Discovery runs one job at a time; the others still wait for its slot.
			expect(started.filter((type) => type !== "link_campaign" && ["search_campaign_kits", "analyze_kit_sibling"].includes(type))).toEqual(["search_campaign_kits"]);
		} finally {
			release();
			await worker.stop();
		}
	});

	test("a site check runs on time while provider work and discovery hold every other slot", async () => {
		const request = await validateAbuseReportRequest({ targets: ["impresspaper.com"], allegationCategory: "phishing", description: "Confirmed credential phishing.", observedUrls: [{ target: "impresspaper.com", urls: ["https://impresspaper.com/invite.html"] }] });
		await SubmissionsEntity.create({ id: 1n, kind: "website", data: { kind: "website", website: { url: "https://impresspaper.com/invite.html" } }, dedupeKey: "lanes-site" });
		const { reportId } = await AbuseRepository.createReport({ request, reporter: {}, submissionId: 1n });
		const past = new Date(Date.now() - 60_000);
		for (const [index, jobType] of (["submit_provider", "submit_provider", "search_campaign_kits", "report_origin_host", "link_campaign"] as const).entries()) {
			await AbuseRepository.enqueueJob({ jobType, reportId, payload: {}, dedupeKey: `busy-${index}`, nextAttemptAt: past });
		}
		await AbuseRepository.enqueueJob({ jobType: "check_site_liveness", reportId, payload: { targetId: "1" }, dedupeKey: "liveness:1", nextAttemptAt: past });

		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		let checked!: () => void;
		const checkedSite = new Promise<void>((resolve) => { checked = resolve; });
		const worker = new AbuseWorker({
			pollMs: 5,
			externalConcurrency: 2,
			processJob: async (job: Job) => {
				if (job.jobType === "check_site_liveness") checked();
				else await blocked;
			},
		});
		await worker.start();
		try {
			await Promise.race([checkedSite, new Promise((_, reject) => setTimeout(() => reject(new Error("the site check waited behind other work")), 2_000))]);
		} finally {
			release();
			await worker.stop();
		}
	});

	test("a visit that finds no browser pauses every visit slot but no other lane, and a visit that succeeds starts the backoff over", async () => {
		const noBrowser = () => new BrowserUnavailableError(new Error("Expected 101 status code"));
		const first = await AbuseRepository.enqueueJob({ jobType: "visit_website", payload: {}, dedupeKey: "visit-0" });
		const visits: number[] = [];
		let livenessAt = 0;
		let failedAt = 0;
		let done!: () => void;
		const fourthVisit = new Promise<void>((resolve) => { done = resolve; });
		const worker = new AbuseWorker({
			pollMs: 5,
			visitConcurrency: 2,
			// Without the reset, the outage after the success would pause 20 s.
			visitOutageBackoffMs: [300, 20_000],
			processJob: async (job: Job) => {
				if (job.jobType === "check_site_liveness") {
					livenessAt = Date.now();
					return;
				}
				visits.push(Date.now());
				if (visits.length === 1) {
					// More visits come due while the pause runs, and a site check too.
					const soon = new Date(Date.now() + 100);
					for (const index of [1, 2]) await AbuseRepository.enqueueJob({ jobType: "visit_website", payload: {}, dedupeKey: `visit-${index}`, nextAttemptAt: soon });
					await AbuseRepository.enqueueJob({ jobType: "check_site_liveness", payload: { targetId: "1" }, dedupeKey: "liveness:1" });
					failedAt = Date.now();
					throw noBrowser();
				}
				if (visits.length === 2) return;
				if (visits.length === 3) {
					// The last visit comes due after this outage, whichever slot is free then.
					await Bun.sleep(50);
					await AbuseRepository.enqueueJob({ jobType: "visit_website", payload: {}, dedupeKey: "visit-3", nextAttemptAt: new Date(Date.now() + 100) });
					failedAt = Date.now();
					throw noBrowser();
				}
				done();
			},
		});
		await worker.start();
		try {
			await Promise.race([fourthVisit, new Promise((_, reject) => setTimeout(() => reject(new Error("the visit lane stayed paused")), 5_000))]);
		} finally {
			await worker.stop();
		}
		const [, second, third, fourth] = visits as [number, number, number, number];
		// No visit slot claimed anything during the first pause; the site check did not wait for it.
		expect(livenessAt).toBeGreaterThan(0);
		expect(livenessAt - visits[0]!).toBeLessThan(250);
		expect(Math.min(second, third) - visits[0]!).toBeGreaterThanOrEqual(280);
		// The success reset the backoff: the next outage paused its first step again.
		expect(fourth - failedAt).toBeGreaterThanOrEqual(280);
		expect(fourth - failedAt).toBeLessThan(3_000);
		// The job without a browser was deferred, spending none of its attempts.
		const db = await getDb();
		expect(db.select().from(jobs).where(eq(jobs.id, first.id)).get()).toMatchObject({ status: "queued", retryCount: 0 });
	}, 15_000);
});
