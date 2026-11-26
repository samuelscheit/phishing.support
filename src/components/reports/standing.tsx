import type { ReactNode } from "react";
import { Check, X } from "lucide-react";

import type { RouteBucket, StepState } from "@/lib/submissions/report_view";
import { cn } from "@/lib/util/cn";

/** Each standing's colours: the badge, the bar segment and the legend swatch. */
export const BUCKET_STYLE: Record<RouteBucket, { pill: string; fill: string; legend: string }> = {
	action_taken: { pill: "border-emerald-200 bg-emerald-50 text-emerald-700", fill: "bg-emerald-600", legend: "took action" },
	bypassed: { pill: "border-orange-200 bg-orange-50 text-orange-700", fill: "bg-orange-400", legend: "acted, then bypassed" },
	received: { pill: "border-sky-200 bg-sky-50 text-sky-700", fill: "bg-emerald-300", legend: "received, no decision yet" },
	declined: { pill: "border-red-200 bg-red-50 text-red-700", fill: "bg-red-300", legend: "no threat found or declined" },
	unconfirmed: { pill: "border-zinc-200 bg-zinc-50 text-zinc-600", fill: "bg-amber-300", legend: "not confirmed yet" },
	waiting: { pill: "border-amber-200 bg-amber-50 text-amber-700", fill: "bg-slate-300", legend: "waiting" },
	not_sent: { pill: "border-dashed border-zinc-300 bg-background text-zinc-500", fill: "bg-zinc-400", legend: "not sent" },
};

export function StandingPill({ bucket, children, className }: { bucket: RouteBucket; children: ReactNode; className?: string }) {
	return (
		<span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", BUCKET_STYLE[bucket].pill, className)}>
			<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
			<span className="truncate">{children}</span>
		</span>
	);
}

const STEP_LABELS = ["Sent", "Received", "Decision"] as const;

function StepDot({ state }: { state: StepState }) {
	return (
		<span className={cn(
			"grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full",
			state === "done" && "bg-emerald-600 text-white",
			state === "negative" && "bg-red-500 text-white",
			state === "waiting" && "border-2 border-amber-500 bg-background",
			state === "unknown" && "border-2 border-dashed border-zinc-400 bg-background",
			state === "todo" && "bg-zinc-200",
		)}>
			{state === "done" ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : state === "negative" ? <X className="h-2.5 w-2.5" strokeWidth={3} /> : null}
		</span>
	);
}

/** Sent → Received → Decision, each step done, negative, waiting, unknown, or still to come; read out as text too. */
export function Steps({ steps }: { steps: { sent: StepState; received: StepState; decision: StepState } }) {
	const states = [steps.sent, steps.received, steps.decision];
	const spoken = STEP_LABELS.map((label, index) => `${label}: ${states[index] === "done" ? "yes" : states[index] === "negative" ? "no" : states[index] === "waiting" ? "waiting" : states[index] === "unknown" ? "not known" : "not yet"}`).join(", ");
	return (
		<div className="w-[7.5rem] shrink-0" role="img" aria-label={spoken}>
			<div className="flex items-center">
				{states.map((state, index) => (
					<span key={STEP_LABELS[index]} className="flex items-center">
						{index > 0 ? <span className={cn("h-0.5 w-[2.4rem]", state === "done" || state === "negative" ? "bg-emerald-600" : "bg-zinc-200")} /> : null}
						<StepDot state={state} />
					</span>
				))}
			</div>
			<div className="mt-1 flex justify-between text-[10px] leading-none text-muted-foreground" aria-hidden>
				{STEP_LABELS.map((label) => <span key={label}>{label}</span>)}
			</div>
		</div>
	);
}

const AVATAR_COLOURS = ["bg-orange-500", "bg-blue-700", "bg-slate-800", "bg-cyan-700", "bg-slate-500", "bg-violet-600", "bg-emerald-700", "bg-rose-600"];

/** A company's initials on a colour of its own, the same on every page. */
export function ProviderAvatar({ name }: { name: string }) {
	const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
	const initials = (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2)).toUpperCase();
	const hash = [...name].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);
	return <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-bold text-white", AVATAR_COLOURS[hash % AVATAR_COLOURS.length])} aria-hidden>{initials}</span>;
}
