import { describe, expect, test } from "bun:test";

import { AnalysisRunsEntity, ArtifactsEntity, SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { AnalysisStreamAttemptError, logAndPersistStream } from "./artifact";

useTemporaryDatabase();

async function createRun() {
	const submissionId = await SubmissionsEntity.create({
		id: 1n,
		kind: "email",
		data: { kind: "email" },
		dedupeKey: `artifact-test-${Math.random()}`,
	});
	return { submissionId, runId: await AnalysisRunsEntity.create(submissionId) };
}

describe("analysis stream consumption", () => {
	test("decodes artifact byte sizes as numbers while preserving exact artifact IDs", async () => {
		const submissionId = await SubmissionsEntity.create({
			id: 1n,
			kind: "website",
			data: { kind: "website", website: { url: "https://artifact-types.example.test" } },
			dedupeKey: "artifact-types",
		});
		const buffer = Buffer.from("artifact byte size");
		const artifactId = await ArtifactsEntity.saveBuffer({
			submissionId,
			name: "website.mhtml",
			kind: "website_mhtml",
			mimeType: "text/mhtml",
			buffer,
		});

		const [artifact] = await ArtifactsEntity.listForSubmission(submissionId);
		expect(artifact).toMatchObject({ id: artifactId, size: buffer.byteLength });
		expect(typeof artifact?.id).toBe("bigint");
		expect(typeof artifact?.size).toBe("number");
	});

	test("wraps a mid-stream provider error without prematurely marking the run failed", async () => {
		const { runId } = await createRun();
		const stream = (async function* () {
			yield { type: "response.created" };
			throw new Error("An error occurred while processing your request");
		})();

		const failure = await logAndPersistStream(stream as any, runId).catch((error) => error);
		expect(failure).toBeInstanceOf(AnalysisStreamAttemptError);
		expect(failure.emittedOutput).toBeFalse();
		expect((await AnalysisRunsEntity.listForSubmission(1n))[0]?.status).toBe("running");
	});

	test("persists a completed response only after the terminal event", async () => {
		const { submissionId, runId } = await createRun();
		const stream = (async function* () {
			yield {
				type: "response.completed",
				response: {
					id: "resp_artifact_test",
					status: "completed",
					output: [{ type: "message", content: [{ type: "output_text", text: "completed" }] }],
					usage: { total_tokens: 7 },
				},
			};
		})();

		const result = await logAndPersistStream(stream as any, runId);
		expect(result.output_text).toBe("completed");
		expect((await AnalysisRunsEntity.listForSubmission(submissionId))[0]).toMatchObject({ status: "completed", tokensUsed: 7 });
	});
});
