import { asRecord } from "@/lib/util/values";
import type { VisitMode } from "@/lib/site_visit/control";
import type { SyntheticField } from "@/lib/site_visit/visit_task";

/**
 * What the case's event stream says about a live visit, folded into one
 * state: the log of what was done (by the agent or a person), and the control
 * state every viewer sees. The stream replays its history to each new
 * connection, so a connection's first message resets the state.
 */

export type Actor = "agent" | "human";

export type LiveEntry =
	| { kind: "step"; url: string; title: string }
	| { kind: "action"; text: string; actionKind: string; actor: Actor }
	| { kind: "download"; fileName: string; url: string };

export type LiveTab = { targetId: string; url: string; title: string; active: boolean };

export type LiveControl = {
	/** The visit, and the state's place among its states: an older state (heard late on the other channel) never replaces a newer one. */
	run: string;
	seq: number;
	mode: VisitMode;
	controller?: string;
	until?: string;
	idleUntil?: string;
	tabs: LiveTab[];
	fakeValues: Partial<Record<SyntheticField, string>>;
	agentRunning: boolean;
};

export type LiveEvents = {
	entries: LiveEntry[];
	/** The last control state; absent until the visit is under way. */
	control?: LiveControl;
	/** The analysis finished: nothing of the visit is live any more, whatever its last control state said. */
	finished: boolean;
};

export const EMPTY_LIVE_EVENTS: LiveEvents = { entries: [], finished: false };
export const MAX_LIVE_ENTRIES = 200;
const MODES: readonly VisitMode[] = ["agent", "pausing", "human", "ended"];

const text = (source: Record<string, unknown>, key: string): string => (typeof source[key] === "string" ? source[key] as string : "");
const optionalText = (source: Record<string, unknown>, key: string): string | undefined => text(source, key) || undefined;

function controlOf(source: Record<string, unknown>): LiveControl | undefined {
	const mode = MODES.find((candidate) => candidate === source.mode);
	if (!mode) return undefined;
	const tabs = (Array.isArray(source.tabs) ? source.tabs : []).flatMap((value): LiveTab[] => {
		const tab = asRecord(value);
		return tab && text(tab, "targetId") ? [{ targetId: text(tab, "targetId"), url: text(tab, "url"), title: text(tab, "title"), active: tab.active === true }] : [];
	});
	const fakeValues = Object.fromEntries(Object.entries(asRecord(source.fakeValues) ?? {}).filter(([, value]) => typeof value === "string" && value)) as LiveControl["fakeValues"];
	return {
		run: text(source, "run"),
		seq: typeof source.seq === "number" && Number.isFinite(source.seq) ? source.seq : 0,
		mode,
		...(optionalText(source, "controller") ? { controller: text(source, "controller") } : {}),
		...(optionalText(source, "until") ? { until: text(source, "until") } : {}),
		...(optionalText(source, "idleUntil") ? { idleUntil: text(source, "idleUntil") } : {}),
		tabs,
		fakeValues,
		agentRunning: source.agentRunning === true,
	};
}

function entryOf(source: Record<string, unknown>): LiveEntry | undefined {
	switch (source.type) {
		case "browser.step":
			return { kind: "step", url: text(source, "url"), title: text(source, "title") };
		case "browser.action":
			return { kind: "action", text: text(source, "text"), actionKind: text(source, "kind"), actor: source.actor === "human" ? "human" : "agent" };
		case "browser.download":
			return { kind: "download", fileName: text(source, "fileName"), url: text(source, "url") };
		default:
			return undefined;
	}
}

/** The state after one message of the stream (its parsed JSON); anything unknown leaves it as it is. */
export function reduceLiveEvent(state: LiveEvents, message: unknown): LiveEvents {
	const source = asRecord(message);
	if (!source) return state;
	// The replay may no longer reach back to the last control state: keep it until a newer one comes.
	if (source.type === "connected") return { ...EMPTY_LIVE_EVENTS, ...(state.control ? { control: state.control } : {}) };
	if (source.type === "browser.control") {
		const control = controlOf(source);
		const current = state.control;
		const newer = control && (!current || current.run !== control.run || control.seq > current.seq);
		return newer ? { ...state, control } : state;
	}
	if (source.type === "analysis.step") {
		return source.step === "completed" || source.step === "failed" || source.progress === 100 ? { ...state, finished: true } : state;
	}
	const entry = entryOf(source);
	return entry ? { ...state, entries: [...state.entries, entry].slice(-MAX_LIVE_ENTRIES) } : state;
}

/** Whether people can watch and drive the visit now. */
export function isLive(events: LiveEvents): boolean {
	return !events.finished && Boolean(events.control) && events.control!.mode !== "ended";
}

/** Who drives, as the console names it. */
export type DriverStatus =
	| { kind: "agent" }
	| { kind: "finishing" }
	| { kind: "pausing"; mine: boolean; label?: string }
	| { kind: "you" }
	| { kind: "other"; label: string }
	| { kind: "ended" };

/** Who drives, for this viewer; `you`: the visit's socket says this viewer drives (or is about to). */
export function driverStatus(control: LiveControl | undefined, you: boolean): DriverStatus {
	if (!control || control.mode === "ended") return { kind: "ended" };
	if (control.mode === "pausing") return { kind: "pausing", mine: you, ...(control.controller ? { label: control.controller } : {}) };
	if (control.mode === "human") return you ? { kind: "you" } : { kind: "other", label: control.controller ?? "Someone" };
	return control.agentRunning ? { kind: "agent" } : { kind: "finishing" };
}

/** The deadline a driver sees: when the turn ends without input, or at the latest, whichever comes first. */
export function turnDeadline(control: LiveControl | undefined, now: number): { reason: "idle" | "limit"; ms: number } | undefined {
	if (!control || control.mode !== "human") return undefined;
	const idle = control.idleUntil ? Date.parse(control.idleUntil) : NaN;
	const limit = control.until ? Date.parse(control.until) : NaN;
	if (Number.isNaN(idle) && Number.isNaN(limit)) return undefined;
	const reason = Number.isNaN(limit) || (!Number.isNaN(idle) && idle <= limit) ? "idle" : "limit";
	return { reason, ms: Math.max(0, (reason === "idle" ? idle : limit) - now) };
}

/** `m:ss` of a duration, rounded up so a turn never shows 0:00 while it lasts. */
export function formatCountdown(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1_000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The label of a made-up value's field: `cardNumber` → `Card number`. */
export function fieldLabel(field: string): string {
	const words = field.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}
