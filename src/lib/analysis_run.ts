import type { ResponseCreateParamsStreaming, ResponseInputItem } from "openai/resources/responses/responses.mjs";

import { AnalysisRunsEntity } from "./db/entities";
import { logAndPersistStream } from "./artifact";
import { model, retry } from "./utils";
import { publishEvent } from "./event/event_transport";

export async function runStreamedAnalysisRun(params: { submissionId: bigint; options: ResponseCreateParamsStreaming }) {
	if (params.options.stream !== true) {
		throw new Error("runStreamedAnalysisRun requires options.stream === true");
	}

	const inputForDb: Array<ResponseInputItem> | undefined = Array.isArray(params.options.input)
		? (params.options.input as Array<ResponseInputItem>)
		: undefined;

	const runId = await AnalysisRunsEntity.create(params.submissionId, inputForDb);

	if (params.submissionId) await publishEvent(`run:${params.submissionId}`, { type: "run.created", runId });

	try {
		params.options.stream = true;
		var stream = await retry(() => model.responses.create(params.options), 3, 2000);
	} catch (err) {
		console.dir(params.options, { depth: null });
		console.dir(err, { depth: null });

		throw err;
	}
	const result = await logAndPersistStream(stream, runId, [runId, params.submissionId]);
	// const result = await logAndPersistStream(stream, runId);
	return { runId, result };
}
