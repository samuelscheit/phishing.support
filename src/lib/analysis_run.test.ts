import { describe, expect, test } from "bun:test";

import { AnalysisRunsEntity, SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { runStreamedAnalysisRun } from "./analysis_run";
import { model } from "./utils";

useTemporaryDatabase();

describe("streamed analysis retry boundary", () => {
	test("retries a provider error delivered after HTTP acceptance", async () => {
		const submissionId = await SubmissionsEntity.create({
			id: 1n,
			kind: "email",
			data: { kind: "email" },
			dedupeKey: "analysis-run-retry",
		});
		let calls = 0;
		const originalCreate = model.responses.create;
		(model.responses as any).create = async () => {
			calls += 1;
			if (calls === 1) {
				return (async function* () {
					yield { type: "response.created" };
					throw new Error("An error occurred while processing your request. request id retry-test");
				})();
			}

			return (async function* () {
				yield {
					type: "response.completed",
					response: {
						id: "response_after_retry",
						status: "completed",
						output: [{ type: "message", content: [{ type: "output_text", text: "analysis recovered" }] }],
						usage: { total_tokens: 11 },
					},
				};
			})();
		};

		try {
			const result = await runStreamedAnalysisRun({
				submissionId,
				analysisKind: "analysis",
				options: { stream: true, model: "gpt-5.5", input: "retry this" },
			});
			expect(calls).toBe(2);
			expect(result.result.output_text).toBe("analysis recovered");
			const persistedRun = (await AnalysisRunsEntity.listForSubmission(submissionId))[0];
			expect(persistedRun).toMatchObject({ status: "completed", tokensUsed: 11n, analysisKind: "analysis" });
		} finally {
			(model.responses as any).create = originalCreate;
		}
	});
});
