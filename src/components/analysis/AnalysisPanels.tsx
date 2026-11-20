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
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/web_lib/util";
import { humanizeAnalysisStep, type AnalysisEntryStatus, type AnalysisStreamState } from "@/lib/analysis_stream_events";
import type { ReaderTimelineEntry } from "@/lib/analysis_stream_view";
import { RUN_STATUS_STYLES, STATUS_LABELS, STATUS_STYLES, displayRunStatus, isTerminal, runStatusLabel } from "./stream_state";

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

export function TimelineEntryView({ entry }: { entry: ReaderTimelineEntry }) {
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

export function AnalysisHeader({ state, finalText }: { state: AnalysisStreamState; finalText: string | null }) {
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

export function FinalAnswer({ text, streaming }: { text: string; streaming: boolean }) {
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
