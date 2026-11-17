/**
 * The browser task agent (`@browser-fabric/task-agent`): an LLM that drives a
 * Chromium tab over raw CDP until a goal is done. Every use in this app goes
 * through this module, so the dependency has one seam.
 */
import { createModel, type ChatModel, type JsonSchema } from "browser-fabric/packages/task-agent/src/index";

export { runTask, Secrets, validateSchema } from "browser-fabric/packages/task-agent/src/index";
export type { ActionLog, ChatModel, ChatRequest, ChatResponse, JsonSchema, RunTaskOptions, StepLog, TaskResult, TaskStatus, ToolCall } from "browser-fabric/packages/task-agent/src/index";

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

/**
 * A step limit from the environment: unset is the default, anything but a
 * whole number in range is a configuration error (never `NaN` sent to a run).
 */
export function taskStepLimit(name: string, value: string | undefined, fallback: number, maximum: number): number {
	const trimmed = value?.trim();
	if (!trimmed) return fallback;
	const steps = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
	if (!(steps >= 1 && steps <= maximum)) throw new Error(`${name} must be a whole number from 1 to ${maximum}.`);
	return steps;
}

/**
 * The model that drives browser tasks: `PHISHING_TASK_MODEL` as
 * `openai/<id>` or `anthropic/<id>`, by default the app's own OpenAI model.
 * The OpenAI side reuses the app's OpenAI configuration (`OPENAI_API_KEY`,
 * `OPENAI_API_BASE_URL`, e.g. OpenRouter, where `<id>` may itself contain a
 * slash); Anthropic reads `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`.
 */
export function browserTaskModel(environment: Environment = process.env): ChatModel {
	const spec = environment.PHISHING_TASK_MODEL?.trim() || `openai/${environment.OPENAI_MODEL?.trim() || "gpt-5.5"}`;
	if (!/^(openai|anthropic)\/\S+$/.test(spec)) throw new Error("PHISHING_TASK_MODEL must be openai/<model> or anthropic/<model>.");
	const openAiKey = environment.OPENAI_API_KEY?.trim();
	if (spec.startsWith("openai/") && !openAiKey) throw new Error("OPENAI_API_KEY is required for the browser task model.");
	return createModel(spec, {
		...(openAiKey ? { OPENAI_API_KEY: openAiKey } : {}),
		...(environment.OPENAI_API_BASE_URL?.trim() ? { OPENAI_BASE_URL: environment.OPENAI_API_BASE_URL.trim() } : {}),
		...(environment.ANTHROPIC_API_KEY?.trim() ? { ANTHROPIC_API_KEY: environment.ANTHROPIC_API_KEY.trim() } : {}),
		...(environment.ANTHROPIC_BASE_URL?.trim() ? { ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL.trim() } : {}),
	});
}

/** Whether the run ended because the agent itself chose `fail`, rather than an error, abort or limit. */
export function agentGaveUp(result: { status: string; steps: ReadonlyArray<{ actions: ReadonlyArray<{ tool: string; ok: boolean }> }> }): boolean {
	return result.status === "failed" && Boolean(result.steps.at(-1)?.actions.some((action) => action.tool === "fail" && action.ok));
}
