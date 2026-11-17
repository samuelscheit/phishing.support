import { agentGaveUp, browserTaskModel, runTask, type ChatModel, type StepLog } from "../browser_task/agent";
import { redactedErrorText } from "../error_text";
import type { SiteVisitTask } from "./task";

/** One thing the agent did or concluded, as the live log and the visit record show it. */
export type VisitAgentAction = { id: string; kind: string; text: string };

export type VisitAgentState =
	| { state: "completed"; output: unknown }
	| { state: "failed"; reason: string };

export type VisitAgentRun = {
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

/** The step as the live log reads it: what the model concluded, then each action's outcome. */
export function stepActions(step: StepLog): VisitAgentAction[] {
	const actions: VisitAgentAction[] = [];
	const thought = step.thought.replace(/\s+/g, " ").trim();
	if (thought) actions.push({ id: `${step.step}`, kind: "thought", text: thought.slice(0, MAX_ACTION_TEXT) });
	step.actions.forEach((action, index) => {
		const outcome = action.output.split("\n")[0]!.trim();
		actions.push({ id: `${step.step}.${index + 1}`, kind: action.tool, text: (outcome || action.tool).slice(0, MAX_ACTION_TEXT) });
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
				// The visit's own budget ends the walk through `signal`.
				timeoutMs: 24 * 60 * 60_000,
				signal: run.signal,
				model: model(),
				onStep: (step) => { for (const action of stepActions(step)) run.onAction(action); },
			});
		} catch (error) {
			return { state: "failed", reason: redactedErrorText(error).slice(0, 500) };
		}
		if (result.status === "done") return { state: "completed", output: result.result };
		// The agent ending the walk itself (the flow ended, blocked the synthetic data, or asked
		// for something it could not give) is a finished visit; its reason is its report.
		if (agentGaveUp(result) || result.status === "needs_input") {
			return { state: "completed", output: { submissionsAttempted: 0, downloadsStarted: 0, asksForPhone: false, stoppedReason: (result.question ?? result.summary).slice(0, 300) } };
		}
		return { state: "failed", reason: redactedErrorText(`${result.status}: ${result.summary}`).slice(0, 500) };
	};
}
