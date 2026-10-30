import { describe, expect, test } from "bun:test";

import { AnalysisRunsEntity, ArtifactsEntity, SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { reportConfirmedWebsitePhishing } from "../abuse/submission_reports";
import { getRetryableSubmission } from "./retry";
import { createWebsiteSubmission, resumePendingWebsiteAnalyses, SubmissionRetryError, retryFailedWebsiteAnalysis, websiteSubmissionUrl } from "./website";

useTemporaryDatabase();

describe("retryFailedWebsiteAnalysis", () => {
	test("rejects a non-website submission before scheduling work", async () => {
		const id = await SubmissionsEntity.create({
			id: 1n,
			kind: "email",
			data: { kind: "email" },
			dedupeKey: "website-retry-email",
			status: "failed",
		});

		await expect(retryFailedWebsiteAnalysis(id)).rejects.toBeInstanceOf(SubmissionRetryError);
		expect((await SubmissionsEntity.get(id))?.status).toBe("failed");
	});

	test("rejects a failed website with no retained URL without claiming it", async () => {
		const id = await SubmissionsEntity.create({
			id: 2n,
			kind: "website",
			data: { kind: "website", website: { url: "" } },
			dedupeKey: "website-retry-no-url",
			status: "failed",
		});

		await expect(retryFailedWebsiteAnalysis(id)).rejects.toThrow("original website URL is unavailable");
		expect((await SubmissionsEntity.get(id))?.status).toBe("failed");
	});

	test("allows a failed classification stage to supersede an earlier completed website stage", async () => {
		const id = await SubmissionsEntity.create({
			id: 3n,
			kind: "website",
			data: { kind: "website", website: { url: "https://example.test" } },
			dedupeKey: "website-retry-latest-stage",
			status: "failed",
		});
		const completedRun = await AnalysisRunsEntity.create(id);
		await AnalysisRunsEntity.complete(completedRun);
		const failedRun = await AnalysisRunsEntity.create(id);
		await AnalysisRunsEntity.fail(failedRun);

		await expect(getRetryableSubmission(id, "website", { allowCompletedPriorRuns: true })).resolves.toMatchObject({
			submission: { id, status: "failed" },
		});
		await expect(getRetryableSubmission(id, "website")).rejects.toBeInstanceOf(SubmissionRetryError);
	});

	test("a website that failed while handing its finding to reporting stays retryable until a report exists", async () => {
		const id = await SubmissionsEntity.create({
			id: 30n,
			kind: "website",
			data: { kind: "website", website: { url: "http://85.215.226.225/Netflix/Home/login.php" } },
			dedupeKey: "website-retry-report-handoff",
			status: "failed",
		});
		for (const _stage of ["analysis", "classification"]) await AnalysisRunsEntity.complete(await AnalysisRunsEntity.create(id));

		await expect(getRetryableSubmission(id, "website", { allowCompletedPriorRuns: true })).resolves.toMatchObject({ submission: { id } });
		await reportConfirmedWebsitePhishing({ submissionId: id, urls: ["https://85.215.226.225/Netflix/Home/login.php"], analysisText: "Credential page.", reporter: {}, phishingBasis: "credential_theft" });
		await expect(getRetryableSubmission(id, "website", { allowCompletedPriorRuns: true })).rejects.toThrow("cannot be retried");
	});

	test("a capture that showed only a cloaking decoy is fetched again instead of re-analyzing the retained decoy", async () => {
		const url = "https://lookup-lgr.to/en/verification";
		const decoyUrl = "https://www.wikipedia.org/";
		const navigationHops = [
			{ index: 0, url, hostname: "lookup-lgr.to", status: 200, redirectTo: decoyUrl, contentCaptured: false },
			{ index: 1, url: decoyUrl, hostname: "www.wikipedia.org", status: 200, contentCaptured: true },
		];
		const id = await SubmissionsEntity.create({
			id: 40n,
			kind: "website",
			data: { kind: "website", website: { url, archiveUrl: decoyUrl, navigationHops, cloaking: { outcome: "unresolved", detail: "decoy only" } } },
			dedupeKey: "website-retry-cloaked",
			status: "failed",
		});
		await ArtifactsEntity.saveWebsiteArtifacts({
			submissionId: id,
			archive: { archivedAt: new Date(), mhtml: Buffer.from("From: <Saved by Blink>\r\n\r\n<html></html>"), screenshotPng: Buffer.from("png") },
		});
		const started: Array<{ mhtmlSnapshot?: Buffer; reuseEvidenceArtifacts?: boolean }> = [];

		await retryFailedWebsiteAnalysis(id, async (options) => started.push(options));

		expect(started).toHaveLength(1);
		expect(started[0]?.mhtmlSnapshot).toBeUndefined();
		expect(started[0]?.reuseEvidenceArtifacts).toBe(false);
	});

	test("marks interrupted running analysis runs as failed on startup so the submission remains retryable", async () => {
		const id = await SubmissionsEntity.create({
			id: 4n,
			kind: "website",
			data: { kind: "website", website: { url: "https://interrupted.example.test" } },
			dedupeKey: "website-retry-interrupted-run",
			status: "running",
		});
		const runId = await AnalysisRunsEntity.create(id, undefined, "analysis");

		await expect(SubmissionsEntity.failAllRunning()).resolves.toEqual([{ id }]);

		const runs = await AnalysisRunsEntity.listForSubmission(id);
		expect(runs).toMatchObject([{ id: runId, status: "failed" }]);
		await expect(getRetryableSubmission(id, "website", { allowCompletedPriorRuns: true })).resolves.toMatchObject({
			submission: { id, status: "failed" },
		});
	});
});

describe("createWebsiteSubmission", () => {
	test("a pasted blob: address is analyzed as the site that served it, keeping what the reporter pasted as the source", async () => {
		const pasted = "blob:https://6996419621491608.9262480229243856756051631876451bau3amzwa.workers.dev/5c83e339-d1c5-4d0b-95ab-8064e20dfcda";
		const started: string[] = [];

		const id = await createWebsiteSubmission({ url: pasted }, async ({ url }) => { started.push(url); });

		const site = "https://6996419621491608.9262480229243856756051631876451bau3amzwa.workers.dev/";
		expect(started).toEqual([site]);
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.data).toEqual({ kind: "website", website: { url: site } });
		expect(submission?.source).toBe(pasted);
	});

	test("ordinary page addresses are kept as submitted", () => {
		expect(websiteSubmissionUrl(" https://kit.example/c2222120?x=1 ")).toBe("https://kit.example/c2222120?x=1");
		expect(websiteSubmissionUrl("http://85.215.226.225/Netflix/Home/login.php")).toBe("http://85.215.226.225/Netflix/Home/login.php");
		expect(() => websiteSubmissionUrl("not a url")).toThrow();
	});
});

describe("resumePendingWebsiteAnalyses", () => {
	test("claims and resumes only legacy new/queued website rows", async () => {
		const legacy = await SubmissionsEntity.create({
			id: 101n,
			kind: "website",
			data: { kind: "website", website: { url: "https://legacy.example.test" } },
			dedupeKey: "legacy-pending-website",
			status: "new",
		});
		await SubmissionsEntity.create({
			id: 102n,
			kind: "email",
			data: { kind: "email" },
			dedupeKey: "legacy-pending-email",
			status: "new",
		});
		const started: bigint[] = [];

		await expect(resumePendingWebsiteAnalyses({
			startAnalysis: async ({ submissionId }) => {
				started.push(submissionId);
			},
		})).resolves.toBe(1);

		expect(started).toEqual([legacy]);
		expect((await SubmissionsEntity.get(legacy))?.status).toBe("running");
		expect((await SubmissionsEntity.get(102n))?.status).toBe("new");
	});

	test("fails a recoverable row with no original URL instead of leaving it pending", async () => {
		const invalid = await SubmissionsEntity.create({
			id: 103n,
			kind: "website",
			data: { kind: "website", website: { url: "" } },
			dedupeKey: "legacy-pending-no-url",
			status: "queued",
		});

		await expect(resumePendingWebsiteAnalyses()).resolves.toBe(0);
		expect(await SubmissionsEntity.get(invalid)).toMatchObject({
			status: "failed",
			info: expect.stringContaining("original URL is unavailable"),
		});
	});
});
