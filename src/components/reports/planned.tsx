import type { ReactNode } from "react";
import { Clock } from "lucide-react";

import type { PlannedEscalationStep } from "@/lib/submissions/planned_escalation";
import { plannedStepText, shortUtc, untilText, type PlannedStepText } from "@/lib/submissions/report_view";
import { cn } from "@/lib/util/cn";
import { formatUtcDateTime } from "@/lib/util/date_time";

/**
 * Planned escalation steps on the case page: drawn dashed, as what will
 * happen rather than what did; amber once due and not taken yet. Read-only.
 */

/** "Follow-up in 2d", "Escalate in 4d", "Follow-up due"; the exact time on hover. */
export function PlannedChip({ step, now }: { step: PlannedEscalationStep; now: Date | string }) {
	const { label } = plannedStepText(step);
	return (
		<span title={formatUtcDateTime(step.at)} className={cn(
			"inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs",
			step.due ? "border-amber-400 bg-amber-50 text-amber-800" : "border-blue-300 text-blue-700",
		)}>
			<Clock className="h-3 w-3" aria-hidden />
			{step.due ? `${label} due` : `${label} ${untilText(step.at, now)}`}
		</span>
	);
}

/** "in 2d · 28 Nov 19:05", or "3h overdue". */
function PlannedTime({ step, now, reference }: { step: PlannedEscalationStep; now: Date | string; reference: Date | string }) {
	const at = new Date(step.at);
	return (
		<time dateTime={at.toISOString()} title={formatUtcDateTime(at)} className={cn("shrink-0 text-xs tabular-nums", step.due ? "text-amber-700" : "text-blue-700")}>
			{step.due ? untilText(at, now) : `${untilText(at, now)} · ${shortUtc(at, reference)}`}
		</time>
	);
}

/** A planned step's heading with its condition, its time, and what it will do; `children` below (what it will send). */
export function PlannedStep({ step, text, now, reference, children }: { step: PlannedEscalationStep; text: PlannedStepText; now: Date | string; reference: Date | string; children?: ReactNode }) {
	return (
		<>
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
				<span className="min-w-0"><span className="font-medium text-zinc-700">{text.heading}</span><span className="text-muted-foreground"> · {text.condition}</span></span>
				<PlannedTime step={step} now={now} reference={reference} />
			</div>
			<div className="mt-1.5 min-w-0 rounded-lg border border-dashed border-zinc-300 bg-muted/30 p-3 text-sm">
				<p className="break-words text-zinc-600 [overflow-wrap:anywhere]">{text.sentence}</p>
				<p className="mt-1 text-xs text-muted-foreground">{text.notes.join(" ")}</p>
				{children ? <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{children}</div> : null}
			</div>
		</>
	);
}

/** The hollow dashed node of a planned timeline entry, and the dashed connector up to the history above it. */
export function PlannedNode() {
	return (
		<>
			<span className="absolute -top-6 left-[6px] h-[29px] border-l border-dashed border-zinc-400" aria-hidden />
			<span className="absolute left-0 top-[5px] h-[13px] w-[13px] rounded-full border-2 border-dashed border-blue-500 bg-background" aria-hidden />
		</>
	);
}
