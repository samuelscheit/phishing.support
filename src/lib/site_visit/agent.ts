import type { AbuseSkyvernAdapter, SkyvernTaskPayload } from "../abuse/skyvern";
import { statusOf } from "../abuse/skyvern/contracts";
import { redactExternalError } from "../abuse/skyvern/adapter";

/** One thing the agent did or decided, as its timeline names it. */
export type VisitAgentAction = { id: string; kind: string; text: string };

export type VisitAgentState =
	| { state: "running" }
	| { state: "completed"; output: unknown }
	| { state: "failed"; reason: string };

/**
 * The agent that walks the site: started on the capture's own browser, so the
 * recording sees every step it takes. Skyvern in production; tests drive the
 * page themselves.
 */
export type VisitAgent = {
	start(task: SkyvernTaskPayload, browserAddress: string): Promise<{ runId: string }>;
	state(runId: string): Promise<VisitAgentState>;
	/** Everything it did so far, oldest first; read for the live log and the record. */
	actions(runId: string): Promise<VisitAgentAction[]>;
	cancel(runId: string): Promise<void>;
};

const TERMINAL = new Set(["completed", "failed", "terminated", "timed_out", "canceled"]);
const MAX_ACTION_TEXT = 300;

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_ACTION_TEXT) : undefined;
}

/**
 * The actions and thoughts in a Skyvern timeline, oldest first. The timeline
 * nests blocks, their actions and thoughts; an action names what it does
 * (`intention`, `reasoning`), a thought what the agent concluded.
 */
export function timelineActions(timeline: unknown): VisitAgentAction[] {
	const found: Array<VisitAgentAction & { at: string }> = [];
	const seen = new Set<string>();
	const walk = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (!node || typeof node !== "object") return;
		const record = node as Record<string, unknown>;
		const id = text(record.action_id) ?? text(record.thought_id);
		if (id && !seen.has(id)) {
			const description = record.action_type
				? text(record.intention) ?? text(record.reasoning) ?? text(record.action_type)
				: text(record.thought) ?? text(record.observation);
			if (description) {
				seen.add(id);
				found.push({ id, kind: text(record.action_type) ?? text(record.thought_type) ?? "thought", text: description, at: text(record.created_at) ?? "" });
			}
		}
		for (const value of Object.values(record)) if (value && typeof value === "object") walk(value);
	};
	walk(timeline);
	return found.sort((a, b) => a.at.localeCompare(b.at)).map(({ at: _at, ...action }) => action);
}

/**
 * Skyvern, attached through Fabric's relay to the browser the capture
 * already holds. Its client is made on the first call, so a visit that never
 * starts the agent never needs Skyvern's configuration.
 */
export function skyvernVisitAgent(createAdapter: () => Pick<AbuseSkyvernAdapter, "createTask" | "getRun" | "cancelRun" | "getRunTimeline">): VisitAgent {
	let made: ReturnType<typeof createAdapter> | undefined;
	const adapter = () => (made ??= createAdapter());
	return {
		start: (task, browserAddress) => adapter().createTask(task, { browserAddress }),
		state: async (runId) => {
			const run = await adapter().getRun(runId);
			const status = statusOf(run);
			if (!status || !TERMINAL.has(status)) return { state: "running" };
			if (status === "completed") return { state: "completed", output: run.output };
			const reason = typeof run.failure_reason === "string" ? run.failure_reason : status;
			return { state: "failed", reason: redactExternalError(`${status}: ${reason}`).slice(0, 500) };
		},
		actions: async (runId) => timelineActions(await adapter().getRunTimeline(runId)),
		cancel: (runId) => adapter().cancelRun(runId),
	};
}
