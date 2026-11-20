import { agentGaveUp, browserTaskModel, runTask, type ChatModel, type StepLog } from "../browser/task/agent";
import { redactedErrorText } from "../util/error_text";
import type { ExfiltrationCanaries } from "../exfiltration/types";
import type { SiteVisitTask } from "./task";
import { DAY_MS } from "../util/date_time";
import { squash } from "../util/text";

/**
 * One thing the agent did or concluded, as the live log and the visit record
 * show it. `selector` is the agent's ref of the element it acted on, `value`
 * what it typed or chose (synthetic values only), `typedAs` the
 * `{{secret:NAME}}` placeholder it typed a secret as, `at` when its step acted.
 */
export type VisitAgentAction = { id: string; kind: string; text: string; selector?: string; value?: string; typedAs?: string; at?: string };

const SECRET_PLACEHOLDER = /^\{\{secret:(\w+)\}\}$/;

/**
 * The action with the synthetic value it put into the page. The agent's log
 * is redacted: a secret is its `{{secret:NAME}}` placeholder and the text says
 * "(secret entered)". The browser typed this visit's synthetic value of that
 * name, which belongs to no one, so the record and the live log state it.
 */
export function revealSyntheticSecret(action: VisitAgentAction, values: ExfiltrationCanaries): VisitAgentAction {
	const name = action.value?.match(SECRET_PLACEHOLDER)?.[1];
	const value = name && Object.hasOwn(values, name) ? values[name as keyof ExfiltrationCanaries] : undefined;
	if (!value) return action;
	return { ...action, text: action.text.replace("(secret entered)", JSON.stringify(value)), value, typedAs: action.value };
}

export type VisitAgentState =
	| { state: "completed"; output: unknown }
	| { state: "failed"; reason: string };

type VisitAgentRun = {
	task: SiteVisitTask;
	/** Browser-level CDP endpoint of the capture's browser (its second relay connection). */
	cdpEndpoint: string;
	/** The capture's tab: the agent continues there and never closes it. */
	targetId: string;
	/** Ends the walk (the visit's budget, or a cancelled job). */
	signal: AbortSignal;
	onAction(action: VisitAgentAction): void;
};

/**
 * The agent that walks the site: started on the capture's own browser and
 * tab, so the recording sees every step it takes. It resolves when the walk
 * ends and never throws for what happens on the site.
 */
export type VisitAgent = (run: VisitAgentRun) => Promise<VisitAgentState>;

const MAX_ACTION_TEXT = 300;
const MAX_ACTION_VALUE = 2_000;

/**
 * What an action typed (`type`'s text) or chose (`select`'s values), as the
 * agent's log keeps it: the log is redacted, so a secret is its placeholder.
 */
function actionValue(args: Record<string, unknown>): string | undefined {
	const chosen = args.values ?? args.value;
	const value = typeof args.text === "string" ? args.text
		: Array.isArray(chosen) ? chosen.map(String).join(", ")
		: typeof chosen === "string" ? chosen
		: undefined;
	return value ? value.slice(0, MAX_ACTION_VALUE) : undefined;
}

/**
 * The step as the live log and the evidence read it: what the model
 * concluded, then each action's outcome with the element and value it acted
 * with. `at` is when the step's actions ended (the agent reports a step once
 * it acted).
 */
export function stepActions(step: StepLog, at: string): VisitAgentAction[] {
	const actions: VisitAgentAction[] = [];
	const thought = squash(step.thought);
	if (thought) actions.push({ id: `${step.step}`, kind: "thought", text: thought.slice(0, MAX_ACTION_TEXT), at });
	step.actions.forEach((action, index) => {
		const outcome = action.output.split("\n")[0]!.trim();
		const selector = typeof action.args.ref === "string" && action.args.ref ? action.args.ref : undefined;
		const value = actionValue(action.args);
		actions.push({ id: `${step.step}.${index + 1}`, kind: action.tool, text: (outcome || action.tool).slice(0, MAX_ACTION_TEXT), ...(selector ? { selector } : {}), ...(value ? { value } : {}), at });
	});
	return actions;
}

/**
 * The browser task agent, attached to the capture's browser. Its model is
 * made on the first walk, so a capture that never visits never needs one.
 */
export function taskAgentVisit(model: () => ChatModel = () => browserTaskModel()): VisitAgent {
	return async (run) => {
		let result;
		try {
			result = await runTask({
				cdpEndpoint: run.cdpEndpoint,
				targetId: run.targetId,
				goal: run.task.goal,
				resultSchema: run.task.resultSchema,
				maxSteps: run.task.maxSteps,
				secrets: run.task.secrets,
				// The agent reads what the page only draws (a CAPTCHA's distorted text, an image puzzle, a canvas form).
				screenshots: true,
				// The tabs the site opened stay: the visit records the page the walk ended on after it ends.
				keepTab: true,
				// The visit's own budget ends the walk through `signal`.
				timeoutMs: DAY_MS,
				signal: run.signal,
				model: model(),
				onStep: (step) => { for (const action of stepActions(step, new Date().toISOString())) run.onAction(action); },
			});
		} catch (error) {
			return { state: "failed", reason: redactedErrorText(error).slice(0, 500) };
		}
		if (result.status === "done") return { state: "completed", output: result.result };
		// The agent ending the walk itself (the flow ended, blocked the synthetic data, or asked
		// for something it could not give) is a finished visit; its reason is its report.
		if (agentGaveUp(result) || result.status === "needs_input") {
			return { state: "completed", output: { asksForPhone: false, blockedByChallenge: false, stoppedReason: (result.question ?? result.summary).slice(0, 300) } };
		}
		return { state: "failed", reason: redactedErrorText(`${result.status}: ${result.summary}`).slice(0, 500) };
	};
}
