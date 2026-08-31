"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";
import {
	Activity,
	AlertCircle,
	BrainCircuit,
	CheckCircle2,
	Code2,
	Globe2,
	LoaderCircle,
	MessageSquareText,
	Search,
	Sparkles,
	Wrench,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/web_lib/util";
import {
	applyAnalysisStreamEvent,
	createInitialAnalysisStreamState,
	extractOutputText,
	humanizeAnalysisStep,
	markAnalysisStreamError,
	markAnalysisStreamOpen,
	type AnalysisEntryStatus,
	type AnalysisStreamState,
} from "@/lib/analysis_stream_events";
import { summarizeAnalysisEntries, type ReaderTimelineEntry } from "@/lib/analysis_stream_view";

// Keep the extraction helper available to other analysis surfaces while the
// timeline owns the SSE-specific rendering.
export { extractOutputText } from "@/lib/analysis_stream_events";

type OutputContent = { type?: string; text?: string; refusal?: string };
export type OutputItem = { type?: string; content?: OutputContent[] };

type StreamAction =
	| { type: "reset"; status?: string; progressExpected?: boolean }
	| { type: "event"; event: unknown }
	| { type: "open" }
	| { type: "error"; message?: string };

function reducer(state: AnalysisStreamState, action: StreamAction): AnalysisStreamState {
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

const STATUS_STYLES: Record<AnalysisEntryStatus, string> = {
	pending: "border-slate-300/70 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
	active: "border-primary/30 bg-primary/10 text-primary",
	complete: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	failed: "border-destructive/30 bg-destructive/10 text-destructive",
	warning: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

const STATUS_LABELS: Record<AnalysisEntryStatus, string> = {
	pending: "Waiting",
	active: "Working",
	complete: "Done",
	failed: "Could not finish",
	warning: "Needs attention",
};

const RUN_STATUS_STYLES: Record<string, string> = {
	idle: "border-slate-300/70 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
	created: "border-slate-300/70 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
	running: "border-primary/30 bg-primary/10 text-primary",
	retrying: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	failed: "border-destructive/30 bg-destructive/10 text-destructive",
	incomplete: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

function isTerminal(state: AnalysisStreamState): boolean {
	if (state.runStatus === "failed" || state.runStatus === "incomplete") return true;
	if (state.runStatus !== "completed") return false;
	// A submission can run a second (classification) pass after the narrative
	// response has completed.  Keep showing the high-level progress stream until
	// that whole pipeline reaches 100%.
	return !state.progressExpected || (state.step?.progress ?? 0) >= 100;
}

function displayRunStatus(state: AnalysisStreamState): AnalysisStreamState["runStatus"] {
	if (state.runStatus === "completed" && state.progressExpected && (state.step?.progress ?? 0) < 100) return "running";
	return state.runStatus;
}

function runStatusLabel(state: AnalysisStreamState): string {
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

function ConnectionBadge({ state }: { state: AnalysisStreamState }) {
	const terminal = isTerminal(state);
	if (terminal) return null;
	const label = state.connection === "connected" ? "Live updates" : state.connection === "error" ? "Updates paused" : "Connecting";
	const className =
		state.connection === "connected"
			? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
			: state.connection === "error"
				? "border-destructive/30 bg-destructive/10 text-destructive"
				: "border-primary/30 bg-primary/10 text-primary";
	const Icon = state.connection === "error" ? AlertCircle : state.connection === "connected" ? CheckCircle2 : LoaderCircle;
	return (
		<Badge variant="outline" className={cn("gap-1.5 text-[10px] font-medium", className)}>
			<Icon className={cn("h-3 w-3", state.connection !== "error" && "animate-pulse")} aria-hidden="true" />
			{label}
		</Badge>
	);
}

function EntryIcon({ entry }: { entry: ReaderTimelineEntry }) {
	let Icon = Activity;
	if (entry.kind === "reasoning") Icon = BrainCircuit;
	if (entry.kind === "tool") {
		Icon = entry.toolType.includes("search")
			? Search
			: entry.toolType.includes("code")
				? Code2
				: entry.toolType.includes("mcp")
					? Globe2
					: Wrench;
	}
	if (entry.kind === "step") Icon = Sparkles;
	if (entry.kind === "notice" && entry.status === "failed") Icon = AlertCircle;
	if (entry.kind === "notice" && entry.status === "complete") Icon = CheckCircle2;
	return <Icon className="h-4 w-4" aria-hidden="true" />;
}

function StatusPill({ status }: { status: AnalysisEntryStatus }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
				STATUS_STYLES[status],
			)}
		>
			{STATUS_LABELS[status]}
		</span>
	);
}

function EntryStatus({ entry }: { entry: ReaderTimelineEntry }) {
	// Completed detail cards are self-explanatory. Keep a status badge for
	// current work and problems, while the overall status remains in the header.
	if (entry.status === "complete" && (entry.kind === "reasoning" || entry.kind === "tool" || entry.kind === "notice")) return null;
	return <StatusPill status={entry.status} />;
}

function ToolDetails({ entry }: { entry: Extract<ReaderTimelineEntry, { kind: "tool" }> }) {
	const searchCount = entry.queryCount;
	return (
		<div className="mt-2 space-y-2">
			{searchCount > 0 ? (
				<div className="text-xs text-muted-foreground">Checked related information.</div>
			) : entry.phase === "Finished" ? (
				<div className="text-xs text-muted-foreground">Information reviewed.</div>
			) : (
				<div className="text-xs text-muted-foreground">Working on this check…</div>
			)}
		</div>
	);
}

function TimelineEntryView({ entry }: { entry: ReaderTimelineEntry }) {
	const detail = entry.kind === "notice" ? entry.detail : undefined;
	const readerDetail =
		entry.id === "run:failed"
			? "The analysis stopped before it could finish."
			: entry.id === "stream:error"
				? "Live updates stopped. Refresh to check for the result."
				: detail;
	return (
		<li className="relative pl-8">
			<div className="absolute left-[0.625rem] top-0 h-full w-px bg-border" aria-hidden="true" />
			<div
				className={cn(
					"absolute left-0 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border",
					STATUS_STYLES[entry.status],
				)}
			>
				<EntryIcon entry={entry} />
			</div>
			<div className="rounded-lg border bg-card/80 p-3 shadow-sm">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div className="min-w-0">
						<div className="text-sm font-semibold text-foreground">
							{entry.kind === "step" ? humanizeAnalysisStep(entry.step) : entry.title}
						</div>
						{entry.kind === "tool" && entry.phase !== "Finished" ? (
							<div className="mt-0.5 text-xs text-muted-foreground">{entry.phase}</div>
						) : null}
					</div>
					<EntryStatus entry={entry} />
				</div>

				{entry.kind === "reasoning" ? (
					<div className="mt-2 space-y-2">
						<p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{entry.text}</p>
						{entry.earlierTexts.length > 0 ? (
							<details className="rounded-md border bg-muted/30 px-2.5 py-2">
								<summary className="cursor-pointer text-xs font-medium text-muted-foreground">Show earlier updates</summary>
								<ul className="mt-2 space-y-1.5 border-l pl-3 text-xs leading-relaxed text-muted-foreground">
									{entry.earlierTexts.map((text, index) => (
										<li key={`${entry.id}:earlier:${index}`}>{text}</li>
									))}
								</ul>
							</details>
						) : null}
					</div>
				) : null}

				{entry.kind === "tool" ? <ToolDetails entry={entry} /> : null}

				{entry.kind !== "step" && entry.kind !== "reasoning" && entry.kind !== "tool" && readerDetail ? (
					<p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{readerDetail}</p>
				) : null}
			</div>
		</li>
	);
}

function AnalysisHeader({ state, finalText }: { state: AnalysisStreamState; finalText: string | null }) {
	const visibleStatus = displayRunStatus(state);
	const statusStyle = RUN_STATUS_STYLES[visibleStatus] ?? RUN_STATUS_STYLES.running;
	const terminal = isTerminal(state);
	return (
		<div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<Activity className="h-4 w-4" aria-hidden="true" />
						</div>
						<div>
							<div className="text-sm font-semibold">Analysis progress</div>
							<div className="text-xs text-muted-foreground">
								{terminal ? "A summary of the checks we made" : "See what is being checked as it happens"}
							</div>
						</div>
					</div>
				</div>
				<div className="flex flex-wrap items-center justify-end gap-1.5">
					<span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", statusStyle)}>
						{runStatusLabel({ ...state, runStatus: visibleStatus })}
					</span>
					<ConnectionBadge state={state} />
				</div>
			</div>

			{state.step ? (
				<div className="rounded-lg border bg-muted/30 p-2.5">
					<div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
						<span className="font-medium">{humanizeAnalysisStep(state.step.name)}</span>
						<span className="text-muted-foreground">
							{typeof state.step.progress === "number" ? `${state.step.progress}%` : "Working…"}
						</span>
					</div>
					<Progress value={state.step.progress ?? 0} className="h-1.5" />
				</div>
			) : null}

			{state.error && !finalText ? (
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					We couldn&apos;t finish this analysis. You can try again.
				</div>
			) : null}
		</div>
	);
}

function FinalAnswer({ text, streaming }: { text: string; streaming: boolean }) {
	return (
		<section className="rounded-xl border border-primary/25 bg-primary/[0.035] p-4 shadow-sm" aria-live="polite">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2 text-sm font-semibold">
					<MessageSquareText className="h-4 w-4 text-primary" aria-hidden="true" />
					Result
				</div>
				<span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
					{streaming ? (
						<LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
					) : (
						<CheckCircle2 className="h-3 w-3" aria-hidden="true" />
					)}
					{streaming ? "Updating" : "Ready"}
				</span>
			</div>
			<MessageResponse isAnimating={streaming} className="pr-0 text-sm leading-relaxed">
				{text}
			</MessageResponse>
		</section>
	);
}

export function AnalysisLogs({
	streamId,
	progressStreamId,
	progressOnly = false,
	output,
	status,
	className,
}: {
	streamId: string | bigint;
	/** The submission topic carries the high-level progress before a run exists. */
	progressStreamId?: string | bigint;
	/** Render only high-level steps for the short period before a run is created. */
	progressOnly?: boolean;
	output?: Array<OutputItem>;
	status?: string;
	className?: string;
}) {
	const [state, dispatch] = useReducer(reducer, status, createInitialAnalysisStreamState);
	const bottomRef = useRef<HTMLDivElement>(null);
	const outputText = useMemo(() => extractOutputText(output), [output]);
	const streamIdText = String(streamId);
	const progressStreamIdText = progressStreamId === undefined ? null : String(progressStreamId);

	useEffect(() => {
		const progressExpected = progressOnly || progressStreamIdText !== null;
		dispatch({ type: "reset", status, progressExpected });
		// A finished run has nothing new to stream. Avoid opening a never-ending
		// connection when a reader revisits a finished or failed analysis.
		if ((outputText || status === "completed" || status === "failed") && !progressExpected) return;
		const streamTargets = [
			...((outputText || status === "completed" || status === "failed") && progressStreamIdText
				? [{ id: progressStreamIdText, primary: false, progress: true }]
				: [{ id: streamIdText, primary: true, progress: progressOnly }]),
			...(progressStreamIdText &&
			progressStreamIdText !== streamIdText &&
			!(outputText || status === "completed" || status === "failed")
				? [{ id: progressStreamIdText, primary: false, progress: true }]
				: []),
		];
		const sources = streamTargets.map(({ id, primary, progress }) => ({
			source: new EventSource(`/api/stream/${encodeURIComponent(id)}${progress ? "?progress=1" : ""}`),
			primary,
			progress,
		}));
		let closed = false;
		let primaryFinishedNormally = false;
		let progressFinishedNormally = false;

		for (const { source, primary, progress } of sources) {
			source.onopen = () => {
				dispatch({ type: "open" });
			};
			source.onmessage = (event: MessageEvent<string>) => {
				if (closed) return;
				try {
					const parsed = JSON.parse(event.data);
					// The submission topic also receives every provider packet from
					// every analysis stage.  Use it only for the high-level progress
					// steps; otherwise the classifier's JSON response could replace
					// the narrative analysis while it is still being displayed.
					const eventType = parsed && typeof parsed === "object" ? (parsed as { type?: unknown }).type : undefined;
					if (primary && (eventType === "run.completed" || eventType === "run.failed")) primaryFinishedNormally = true;
					if (progress && eventType === "analysis.step" && parsed && typeof parsed === "object") {
						const step = (parsed as { step?: unknown }).step;
						const progressValue = (parsed as { progress?: unknown }).progress;
						if (step === "completed" || step === "failed" || progressValue === 100) progressFinishedNormally = true;
					}
					if (
						progressOnly &&
						primary &&
						eventType !== "analysis.step" &&
						eventType !== "run.failed" &&
						eventType !== "run.completed"
					)
						return;
					if (!primary && eventType !== "analysis.step") return;
					dispatch({ type: "event", event: parsed });
				} catch {
					// Keep malformed packets visible as a state change without rendering
					// untrusted/raw payloads into the page.
					if (primary) dispatch({ type: "event", event: { type: "stream.malformed" } });
				}
			};
			source.onerror = () => {
				const endedNormally = (primary && primaryFinishedNormally) || (progress && progressFinishedNormally);
				// Progress is a best-effort companion stream. A failure there should
				// not make an otherwise healthy analysis look broken when the primary
				// run stream is still available.
				if (!closed && !endedNormally && (primary || sources.length === 1)) {
					dispatch({ type: "error", message: primary ? undefined : "Progress updates paused." });
				}
				source.close();
			};
		}

		return () => {
			closed = true;
			for (const { source } of sources) source.close();
		};
	}, [outputText, progressOnly, progressStreamIdText, status, streamIdText]);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [state.entries.length, state.outputText, state.step?.name, state.step?.progress]);

	const finalText = outputText ?? (state.outputText || state.refusalText || null);
	const terminal = isTerminal(state);
	const classNameValue = className ?? "h-[34rem]";
	const visibleEntries = summarizeAnalysisEntries(state.entries);
	const waitingLabel = terminal
		? "No result was returned."
		: state.runStatus === "running"
			? "Waiting for the next update…"
			: "Waiting for the analysis to start…";

	return (
		<ScrollArea className={cn("w-full", classNameValue)}>
			<div className="space-y-4 pr-4">
				<AnalysisHeader state={state} finalText={finalText} />

				{visibleEntries.length > 0 ? (
					<ol className="space-y-3" aria-label="Analysis event timeline">
						{visibleEntries.map((entry) => (
							<TimelineEntryView key={entry.id} entry={entry} />
						))}
					</ol>
				) : terminal && finalText ? null : (
					<div className="rounded-lg border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
						{waitingLabel}
					</div>
				)}

				{finalText ? <FinalAnswer text={finalText} streaming={!terminal && !outputText} /> : null}
				{!finalText && !terminal ? (
					<div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
						<LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
						Waiting for the result…
					</div>
				) : null}
				<div ref={bottomRef} />
			</div>
		</ScrollArea>
	);
}
