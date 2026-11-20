import {
	applyAnalysisStreamEvent,
	createInitialAnalysisStreamState,
	markAnalysisStreamError,
	markAnalysisStreamOpen,
	type AnalysisEntryStatus,
	type AnalysisStreamState,
} from "@/lib/analysis/stream_events";

export type StreamAction =
	| { type: "reset"; status?: string; progressExpected?: boolean }
	| { type: "event"; event: unknown }
	| { type: "open" }
	| { type: "error"; message?: string };

export function reducer(state: AnalysisStreamState, action: StreamAction): AnalysisStreamState {
	switch (action.type) {
		case "reset":
			return createInitialAnalysisStreamState(action.status, action.progressExpected);
		case "event":
			return applyAnalysisStreamEvent(state, action.event);
		case "open":
			return markAnalysisStreamOpen(state);
		case "error":
			return markAnalysisStreamError(state, action.message);
	}
}

export const STATUS_STYLES: Record<AnalysisEntryStatus, string> = {
	pending: "border-slate-300/70 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
	active: "border-primary/30 bg-primary/10 text-primary",
	complete: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	failed: "border-destructive/30 bg-destructive/10 text-destructive",
	warning: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

export const STATUS_LABELS: Record<AnalysisEntryStatus, string> = {
	pending: "Waiting",
	active: "Working",
	complete: "Done",
	failed: "Could not finish",
	warning: "Needs attention",
};

export const RUN_STATUS_STYLES: Record<string, string> = {
	idle: "border-slate-300/70 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
	created: "border-slate-300/70 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
	running: "border-primary/30 bg-primary/10 text-primary",
	retrying: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	failed: "border-destructive/30 bg-destructive/10 text-destructive",
	incomplete: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

export function isTerminal(state: AnalysisStreamState): boolean {
	if (state.runStatus === "failed" || state.runStatus === "incomplete") return true;
	if (state.runStatus !== "completed") return false;
	// A submission can run a second (classification) pass after the narrative
	// response has completed.  Keep showing the high-level progress stream until
	// that whole pipeline reaches 100%.
	return !state.progressExpected || (state.step?.progress ?? 0) >= 100;
}

export function displayRunStatus(state: AnalysisStreamState): AnalysisStreamState["runStatus"] {
	if (state.runStatus === "completed" && state.progressExpected && (state.step?.progress ?? 0) < 100) return "running";
	return state.runStatus;
}

export function runStatusLabel(state: AnalysisStreamState): string {
	if (state.connection === "error" && !isTerminal(state)) return "Updates paused";
	const labels: Record<string, string> = {
		idle: "Waiting",
		created: "Starting",
		running: "Checking",
		retrying: "Trying again",
		completed: "Complete",
		failed: "Could not finish",
		incomplete: "Partially complete",
	};
	return labels[state.runStatus] ?? "Running";
}
