import { Stream } from "openai/streaming";
import { ResponseStreamEvent } from "openai/resources/responses/responses.mjs";
import { AnalysisRunsEntity } from "./db/entities";
import { publishEvent } from "./event/event_transport";
import { extractResponseOutputText, parseResponseJson } from "./openai_response";

/**
 * Consumes an OpenAI stream, logs it to stdout, publishes it to ZeroMQ,
 * and persists the final result to the analysis_runs table.
 */
export async function logAndPersistStream(response: Stream<ResponseStreamEvent>, runId: bigint, topics?: (bigint | undefined)[]) {
	const emitEvent = (opts: any) =>
		Promise.all(
			(topics || [runId]).map(async (runId) => {
				if (!runId) return;

				const topic = `run:${runId}`;
				await publishEvent(topic, opts);
			})
		);

	try {
		await emitEvent({ type: "run.started" });

		for await (const chunk of response) {
			// Fan out everything to ZeroMQ
			await emitEvent(chunk);

			// Regular logging to stdout
			if (chunk.type === "response.output_text.delta") {
				process.stdout.write(chunk.delta);
			} else if (chunk.type === "response.reasoning_summary_text.delta") {
				process.stdout.write(chunk.delta);
			} else if (chunk.type === "response.completed") {
				const output_text = extractResponseOutputText(chunk.response);
				let output_parsed = null;

				if (chunk.response.status === "completed") {
					try {
						output_parsed = parseResponseJson(chunk.response, output_text);
					} catch (error) {
						// For non-JSON expected outputs, this is fine
					}
				}

				const result = {
					...chunk.response,
					output_text,
					output_parsed,
				};

				// Persist final result to DB
				await AnalysisRunsEntity.complete(runId, result.output, result.usage?.total_tokens);

				await emitEvent({ type: "run.completed", result });

				return result;
			}
		}

		throw new Error("Stream ended without completion");
	} catch (error) {
		console.error(`Error in logAndPersistStream`, error);
		await AnalysisRunsEntity.fail(runId);
		await emitEvent({ type: "run.failed", runId, error: String(error) });
		throw error;
	}
}
