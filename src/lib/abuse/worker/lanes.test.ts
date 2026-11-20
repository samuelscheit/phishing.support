import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import type { AbuseJob } from "../schema";
import { AbuseWorker } from "./";

useTemporaryDatabase();

describe("the worker's lanes", () => {
	test("a site just reported is linked into its campaign while a kit search and sibling analyses hold the discovery slot", async () => {
		// Production: a site reported at 14:13 stayed a campaign of one for hours, its link job queued behind 170 browser analyses of kit siblings.
		const request = await validateAbuseReportRequest({ targets: ["impresspaper.com"], allegationCategory: "phishing", description: "Confirmed credential phishing.", observedUrls: [{ target: "impresspaper.com", urls: ["https://impresspaper.com/invite.html"] }] });
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
			processJob: async (job: AbuseJob) => {
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
			processJob: async (job: AbuseJob) => {
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
});
