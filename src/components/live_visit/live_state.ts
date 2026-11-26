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

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const text = (source: Record<string, unknown>, key: string): string => (typeof source[key] === "string" ? source[key] as string : "");
const optionalText = (source: Record<string, unknown>, key: string): string | undefined => text(source, key) || undefined;

function controlOf(source: Record<string, unknown>): LiveControl | undefined {
	const mode = MODES.find((candidate) => candidate === source.mode);
	if (!mode) return undefined;
	const tabs = (Array.isArray(source.tabs) ? source.tabs : []).flatMap((value): LiveTab[] => {
		const tab = record(value);
		return tab && text(tab, "targetId") ? [{ targetId: text(tab, "targetId"), url: text(tab, "url"), title: text(tab, "title"), active: tab.active === true }] : [];
	});
	const fakeValues = Object.fromEntries(Object.entries(record(source.fakeValues) ?? {}).filter(([, value]) => typeof value === "string" && value)) as LiveControl["fakeValues"];
	return {
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
	const source = record(message);
	if (!source) return state;
	if (source.type === "connected") return EMPTY_LIVE_EVENTS;
	if (source.type === "browser.control") {
		const control = controlOf(source);
		return control ? { ...state, control } : state;
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

/**
 * Who drives, for this viewer: `mine` holds when the viewer's take succeeded
 * and the stream names it (or does not name anyone else) as the controller.
 */
export function driverStatus(control: LiveControl | undefined, viewer: { label?: string; driving: boolean }): DriverStatus {
	if (!control || control.mode === "ended") return { kind: "ended" };
	const mine = viewer.driving && (!control.controller || !viewer.label || control.controller === viewer.label);
	if (control.mode === "pausing") return { kind: "pausing", mine, ...(control.controller ? { label: control.controller } : {}) };
	if (control.mode === "human") return mine ? { kind: "you" } : { kind: "other", label: control.controller ?? "Someone" };
	return control.agentRunning ? { kind: "agent" } : { kind: "finishing" };
}

/** What a viewer holds of the controls: the token its take returned, and whether the stream has named it the driver since. */
export type DriverToken = { token?: string; confirmed: boolean };

/**
 * The token after a control state arrives. A take's answer can beat the
 * stream's control event, so a token is only dropped once the stream named
 * this viewer the driver and later names someone else or nobody.
 */
export function reconcileToken(held: DriverToken, control: LiveControl | undefined, label: string | undefined): DriverToken {
	if (!held.token) return { confirmed: false };
	if (!control || control.mode === "ended") return { confirmed: false };
	const holding = control.mode === "pausing" || control.mode === "human";
	const named = holding && (label === undefined ? Boolean(control.controller) : control.controller === label);
	if (named) return held.confirmed ? held : { ...held, confirmed: true };
	return held.confirmed ? { confirmed: false } : held;
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
