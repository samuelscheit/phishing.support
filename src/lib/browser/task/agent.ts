/**
 * The browser task agent (`@browser-fabric/task-agent`): an LLM that drives a
 * Chromium tab over raw CDP until a goal is done. Every use in this app goes
 * through this module, so the dependency has one seam.
 */
import { createModel, type ChatModel, type JsonSchema } from "browser-fabric/packages/task-agent/src/index";

export { runTask, validateSchema } from "browser-fabric/packages/task-agent/src/index";
export type { ChatModel, ChatRequest, StepLog, TaskResult, TaskSteering } from "browser-fabric/packages/task-agent/src/index";

/** What a browser task is asked to do: everything but where it runs and with which model. */
export type BrowserTask = {
	goal: string;
	/** The first page; omitted when the agent continues in a tab that is already open. */
	startUrl?: string;
	/** Model turns before the run stops with `step_limit`. */
	maxSteps: number;
	/** The `done` result must match it; a mismatch goes back to the model. */
	resultSchema: JsonSchema;
};

type Environment = Readonly<Record<string, string | undefined>>;

/** The model that drives browser tasks: the app's own OpenAI model, key and endpoint (`OPENAI_API_BASE_URL` may be a gateway such as OpenRouter, whose model id may contain a slash). */
export function browserTaskModel(environment: Environment = process.env): ChatModel {
	const apiKey = environment.OPENAI_API_KEY?.trim();
	if (!apiKey) throw new Error("OPENAI_API_KEY is required for the browser task model.");
	const baseUrl = environment.OPENAI_API_BASE_URL?.trim();
	return createModel(`openai/${environment.OPENAI_MODEL?.trim() || "gpt-5.5"}`, {
		OPENAI_API_KEY: apiKey,
		...(baseUrl ? { OPENAI_BASE_URL: baseUrl } : {}),
	});
}

/** Whether the run ended because the agent itself chose `fail`, rather than an error, abort or limit. */
export function agentGaveUp(result: { status: string; steps: ReadonlyArray<{ actions: ReadonlyArray<{ tool: string; ok: boolean }> }> }): boolean {
	return result.status === "failed" && Boolean(result.steps.at(-1)?.actions.some((action) => action.tool === "fail" && action.ok));
}
