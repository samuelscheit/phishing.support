import { ArrowLeft, ArrowRight, Brain, Camera, CheckSquare, Download, Flag, Globe, Hand, Keyboard, ListChecks, MessageSquare, Move, MousePointerClick, MoveVertical, PanelTop, RotateCw, Sparkles, Undo2, Upload, UserRound } from "lucide-react";

import { cn } from "@/lib/util/cn";
import { hostOf } from "@/lib/network/url";
import type { LiveEntry } from "./live_state";

/** An icon for each kind of action, the agent's and a person's; anything else is a click. */
const ACTION_ICONS: Record<string, typeof MousePointerClick> = {
	thought: Brain,
	input_text: Keyboard,
	keypress: Keyboard,
	type: Keyboard,
	key: Keyboard,
	select_option: ListChecks,
	checkbox: CheckSquare,
	upload_file: Upload,
	download_file: Download,
	goto_url: Globe,
	complete: Flag,
	terminate: Flag,
	scroll: MoveVertical,
	drag: Move,
	back: ArrowLeft,
	forward: ArrowRight,
	reload: RotateCw,
	tab: PanelTop,
	capture: Camera,
	message: MessageSquare,
	takeover: Hand,
	handback: Undo2,
};

export type RowTone = "muted" | "danger" | "human";

export function TimelineRow({ icon, tone = "muted", children }: { icon: React.ReactNode; tone?: RowTone; children: React.ReactNode }) {
	return (
		<li className="flex gap-2.5 py-1.5">
			<span
				className={cn(
					"mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
					tone === "danger" ? "bg-destructive/10 text-destructive" : tone === "human" ? "bg-sky-500/15 text-sky-700 dark:text-sky-300" : "bg-muted text-muted-foreground",
				)}
			>
				{icon}
			</span>
			<div className="min-w-0 flex-1 text-xs leading-relaxed">{children}</div>
		</li>
	);
}

/** Marks what a person did, set apart from the agent's actions. */
function PersonTag() {
	return (
		<span className="mr-1.5 inline-flex items-center gap-0.5 rounded bg-sky-500/15 px-1 py-px align-[1px] text-[10px] font-medium text-sky-700 dark:text-sky-300">
			<UserRound className="h-2.5 w-2.5" aria-hidden />
			Person
		</span>
	);
}

/** One entry of a visit's log: a page reached, an action (the agent's or a person's), or a download. */
export function LiveEntryRow({ entry }: { entry: LiveEntry }) {
	if (entry.kind === "step") {
		return (
			<TimelineRow icon={<Sparkles className="h-3 w-3" />}>
				Reached <span className="font-mono">{hostOf(entry.url)}</span>{entry.title ? <span className="text-muted-foreground"> · {entry.title}</span> : null}
			</TimelineRow>
		);
	}
	if (entry.kind === "download") {
		return (
			<TimelineRow icon={<Download className="h-3 w-3" />} tone="danger">
				Downloaded <span className="font-mono">{entry.fileName}</span>
			</TimelineRow>
		);
	}
	const Icon = ACTION_ICONS[entry.actionKind] ?? MousePointerClick;
	const human = entry.actor === "human";
	return (
		<TimelineRow icon={<Icon className="h-3 w-3" />} tone={human ? "human" : "muted"}>
			{human ? <PersonTag /> : null}
			<span className="break-words">{entry.text}</span>
		</TimelineRow>
	);
}
