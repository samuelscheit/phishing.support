"use client";

import { useEffect, useState } from "react";
import { Bot, Hourglass, Loader2, Timer, UserRound } from "lucide-react";

import { cn } from "@/lib/util/cn";
import { formatCountdown, turnDeadline, type DriverStatus, type LiveControl, type LiveTab } from "./live_state";

/** The visit is recorded whoever drives: pages, traffic, downloads and every action. */
export function RecordingChip() {
	return (
		<span className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive max-sm:py-1.5" title="Everything in this browser is recorded in the case: pages, traffic, downloads and every action.">
			<span className="relative flex h-1.5 w-1.5" aria-hidden>
				<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60 motion-reduce:hidden" />
				<span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-destructive" />
			</span>
			<span className="max-sm:sr-only">Recording</span>
		</span>
	);
}

const BADGE_TONE = {
	agent: "bg-muted text-foreground",
	you: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
	other: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
	pending: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
	ended: "bg-muted text-muted-foreground",
} as const;

/** What a badge says about who drives. */
export function driverText(status: DriverStatus): { text: string; tone: keyof typeof BADGE_TONE } {
	switch (status.kind) {
		case "agent":
			return { text: "Agent driving", tone: "agent" };
		case "finishing":
			return { text: "Agent finishing the visit", tone: "agent" };
		case "pausing":
			return { text: status.mine ? "Agent finishing its action…" : `${status.label ?? "Someone"} takes over…`, tone: "pending" };
		case "you":
			return { text: "You're driving", tone: "you" };
		case "other":
			return { text: `${status.label} driving`, tone: "other" };
		case "ended":
			return { text: "Visit ended", tone: "ended" };
	}
}

export function DriverBadge({ status }: { status: DriverStatus }) {
	const { text, tone } = driverText(status);
	const Icon = status.kind === "pausing" ? Loader2 : status.kind === "you" || status.kind === "other" ? UserRound : Bot;
	return (
		<span role="status" className={cn("flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", BADGE_TONE[tone])}>
			<Icon className={cn("h-3.5 w-3.5", status.kind === "pausing" && "animate-spin motion-reduce:animate-none")} aria-hidden />
			{text}
		</span>
	);
}

/** How long the person's turn lasts: until it ends without input, or at the latest. */
export function TurnCountdown({ control }: { control: LiveControl | undefined }) {
	const [now, setNow] = useState(() => Date.now());
	const active = control?.mode === "human";
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [active, control?.idleUntil, control?.until]);
	const deadline = turnDeadline(control, now);
	if (!deadline) return null;
	const urgent = deadline.ms <= 15_000;
	const Icon = deadline.reason === "idle" ? Hourglass : Timer;
	return (
		<span
			className={cn("flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium tabular-nums", urgent ? "bg-amber-500/15 text-amber-800 dark:text-amber-200" : "text-muted-foreground")}
			title={deadline.reason === "idle" ? "The turn ends after 60 seconds without input; any input restarts it." : "The turn ends at its time limit; people can drive a visit 30 minutes in total."}
		>
			<Icon className="h-3.5 w-3.5" aria-hidden />
			<span className="sr-only">{deadline.reason === "idle" ? "Turn ends without input in" : "Turn ends in"}</span>
			{formatCountdown(deadline.ms)}
			<span className="hidden sm:inline">{deadline.reason === "idle" ? " idle" : " left"}</span>
		</span>
	);
}

/** The visit's tabs, when it has several: the driver switches between them. */
export function TabStrip({ tabs, onSelect }: { tabs: LiveTab[]; onSelect?: (targetId: string) => void }) {
	return (
		<div role="tablist" aria-label="Tabs of the visit" className="flex gap-1 overflow-x-auto border-b px-3 py-1.5">
			{tabs.map((tab, index) => {
				const label = tab.title || hostLabel(tab.url) || `Tab ${index + 1}`;
				return (
					<button
						key={tab.targetId}
						type="button"
						role="tab"
						aria-selected={tab.active}
						disabled={!onSelect || tab.active}
						title={tab.url}
						onClick={() => onSelect?.(tab.targetId)}
						className={cn(
							"max-w-56 shrink-0 truncate rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							tab.active ? "bg-muted font-medium text-foreground" : "text-muted-foreground enabled:hover:bg-muted/60 enabled:hover:text-foreground disabled:cursor-default",
						)}
					>
						{label}
					</button>
				);
			})}
		</div>
	);
}

function hostLabel(url: string): string {
	try {
		const { host, pathname } = new URL(url);
		return `${host.replace(/^www\./, "")}${pathname === "/" ? "" : pathname}`;
	} catch {
		return url;
	}
}
