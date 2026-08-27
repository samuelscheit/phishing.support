import { describe, expect, test } from "bun:test";

import { AnalysisRunsEntity, SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { getRetryableSubmission } from "./retry";
import { SubmissionRetryError, retryFailedWebsiteAnalysis } from "./website";

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
