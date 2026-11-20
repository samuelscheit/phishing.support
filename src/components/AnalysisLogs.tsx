"use client";

import { useEffect, useMemo, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/web_lib/util";
import { extractOutputText } from "@/lib/analysis_stream_events";
import { summarizeAnalysisEntries } from "@/lib/analysis_stream_view";
import { AnalysisHeader, FinalAnswer, TimelineEntryView } from "./analysis/AnalysisPanels";
import { isTerminal } from "./analysis/stream_state";
import { useAnalysisStream } from "./analysis/useAnalysisStream";

type OutputContent = { type?: string; text?: string; refusal?: string };
export type OutputItem = { type?: string; content?: OutputContent[] };

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
	const bottomRef = useRef<HTMLDivElement>(null);
	const outputText = useMemo(() => extractOutputText(output), [output]);
	const state = useAnalysisStream({ streamId, progressStreamId, progressOnly, outputText, status });

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
