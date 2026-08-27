import type { ResponseCreateParamsStreaming, ResponseInputItem } from "openai/resources/responses/responses.mjs";

import { analysisRetryDelayMs, describeAnalysisError, isRetryableAnalysisError } from "./analysis_retry";
import { AnalysisStreamAttemptError, logAndPersistStream } from "./artifact";
import { AnalysisRunsEntity } from "./db/entities";
import { model, sleep } from "./utils";
import { publishEvent } from "./event/event_transport";

const MAX_ANALYSIS_ATTEMPTS = Math.max(1, Number.parseInt(process.env.OPENAI_ANALYSIS_MAX_ATTEMPTS ?? "3", 10) || 3);

function retryDiagnostic(error: unknown, attempts: number, emittedOutput: boolean) {
	return {
		attempts,
		emittedOutput,
		lastError: describeAnalysisError(error),
		failedAt: new Date().toISOString(),
	};
}

export async function runStreamedAnalysisRun(params: { submissionId: bigint; options: ResponseCreateParamsStreaming }) {
	if (params.options.stream !== true) {
		throw new Error("runStreamedAnalysisRun requires options.stream === true");
	}

	const inputForDb: Array<ResponseInputItem> | undefined = Array.isArray(params.options.input)
		? (params.options.input as Array<ResponseInputItem>)
		: undefined;

	const runId = await AnalysisRunsEntity.create(params.submissionId, inputForDb);

	const topics = [runId, params.submissionId];
	const emit = (event: Record<string, unknown>) =>
		Promise.all(topics.map((topic) => publishEvent(`run:${topic}`, event)));

	await emit({ type: "run.created", runId });
	await emit({ type: "run.started", runId });

	for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt += 1) {
		let emittedOutput = false;
		try {
			params.options.stream = true;
			const stream = await model.responses.create(params.options);
			const result = await logAndPersistStream(stream, runId, topics);
			return { runId, result };
		} catch (error) {
			if (error instanceof AnalysisStreamAttemptError) emittedOutput = error.emittedOutput;
			const retryable = !emittedOutput && isRetryableAnalysisError(error);
			const exhausted = attempt === MAX_ANALYSIS_ATTEMPTS;

			if (!retryable || exhausted) {
				const diagnostic = retryDiagnostic(error, attempt, emittedOutput);
				console.error("Analysis stream failed permanently", diagnostic, error);
				await AnalysisRunsEntity.fail(runId, diagnostic);
				await emit({ type: "run.failed", runId, error: diagnostic.lastError, diagnostic });
				throw error;
			}

			const delayMs = analysisRetryDelayMs(attempt);
			const diagnostic = retryDiagnostic(error, attempt, emittedOutput);
			console.warn("Retrying transient analysis stream failure", { ...diagnostic, delayMs });
			await AnalysisRunsEntity.update(runId, { data: { retry: { ...diagnostic, nextAttempt: attempt + 1, delayMs } } });
			await emit({ type: "run.retrying", runId, attempt: attempt + 1, maxAttempts: MAX_ANALYSIS_ATTEMPTS, delayMs, error: diagnostic.lastError });
			await sleep(delayMs);
		}
	}

	throw new Error("Analysis retry loop ended unexpectedly.");
}
