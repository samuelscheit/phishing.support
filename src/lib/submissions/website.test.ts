import { describe, expect, test } from "bun:test";

import { AnalysisRunsEntity, SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { getRetryableSubmission } from "./retry";
import { resumePendingWebsiteAnalyses, SubmissionRetryError, retryFailedWebsiteAnalysis } from "./website";

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
