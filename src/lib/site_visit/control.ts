import { createHash, randomUUID } from "node:crypto";
import type { Page } from "rebrowser-puppeteer-core";

import type { TaskSteering } from "../browser/task/agent";
import type { VisitorTab, VisitorTabs } from "../browser/visitor_tabs";
import { errorText } from "../util/error_text";
import type { VisitAgentAction } from "./agent";
import { ALT, CTRL, describeElementAt, describeFocusedElement, dispatchPageInput, keyAllowed, META, releasePointer, SHIFT, type InputTab, type LiveInput, type PointerState } from "./live_input";
import { LiveScreen, type ScreenTab } from "./screen";
import type { SyntheticField } from "./visit_task";

/**
 * Who drives a live visit: the agent, or for a while a person watching it.
 * Anyone watching a live visit may take the browser over, one person at a
 * time. The agent stops at its next turn (an unanswered model call is
 * dropped), the person drives the same tab with the browser's own input
 * events, and when they hand back the agent goes on, in the tab they left,
 * with an account of what they did. Everything they do is recorded like the
 * agent's actions, marked as a person's, and the visit's recording (pages,
 * traffic, downloads, clipboard) runs on unchanged, since it never depended
 * on who drives.
 *
 * A visit can be live before its agent starts: while the site loads (a
 * browser starts on an exit, an exit fails and the next is tried) people
 * watch the loading tab and read what happens, and the agent's visit takes
 * over the same control, its viewers and their sockets once it starts.
 */

/** `loading`: the site loads and people only watch; `pausing`: a person took over and the agent is finishing its current action; `ended`: the visit is over. */
export type VisitMode = "loading" | "agent" | "pausing" | "human" | "ended";

/** How a control starts: `loading` while the site loads before the agent starts (watch only), `agent` once it walks. */
export type VisitControlOptions = { mode?: "loading" | "agent"; status?: string };

/** A visit's control state, as every viewer sees it. */
export type VisitControlEvent = {
	type: "browser.control";
	/** The visit this state is of, and its place among the visit's states: a viewer that hears a state twice (the case's stream and its socket) keeps the newest. */
	run: string;
	seq: number;
	mode: VisitMode;
	/** What happens now, e.g. which exit the site loads through; absent when there is nothing to say. */
	status?: string;
	/** Who drives while a person does. */
	controller?: string;
	/** When the person's turn ends at the latest, and when it ends without input. */
	until?: string;
	idleUntil?: string;
	tabs: Array<{ targetId: string; url: string; title: string; active: boolean }>;
	/** The made-up values a person can enter with one click. */
	fakeValues: Partial<Record<SyntheticField, string>>;
	/** Whether the agent is still walking (a person's messages reach it). */
	agentRunning: boolean;
};

/** A person's turn ends after this long without input, */
export const TAKEOVER_IDLE_MS = 60_000;
/** after this long in any case, */
export const TAKEOVER_MAX_MS = 10 * 60_000;
/** and people drive one visit this long in total at most. */
export const HUMAN_TOTAL_MS = 30 * 60_000;
/** Every turn counts at least this long: taking over and handing back at once cannot stall the agent forever. */
export const MIN_TURN_CHARGE_MS = 15_000;
/** Inputs a driver may send per second (pointer moves of a drag included). */
const INPUTS_PER_SECOND = 120;
/** A person's actions in one visit; past this, their turn ends and nobody takes over again. */
export const MAX_HUMAN_ACTIONS = 2_000;
export const MAX_MESSAGE = 500;
/** One message per viewer this often at most, */
const MESSAGE_INTERVAL_MS = 2_000;
/** and this many from everyone per minute. */
const MESSAGES_PER_MINUTE = 20;
/** Notes waiting for the agent's next turn; older messages give way. */
const MAX_NOTES = 20;
/** A person's actions the agent is told about when they hand back, and how much of each typed value. */
const MAX_HANDOFF_ACTIONS = 30;
const MAX_HANDOFF_VALUE = 200;
/** Characters one typing record holds; typing on starts the next record. */
const MAX_TYPED = 2_000;
/** Scroll events this close together are one scroll. */
const SCROLL_COALESCE_MS = 2_000;
/** A press that moved this far (CSS px) is a drag, not a click. */
const DRAG_DISTANCE = 8;
/** While a person drives, viewers hear when their turn ends without input at most this often. */
const IDLE_REPORT_MS = 10_000;

export type ControlResult<T = object> = ({ ok: true } & T) | { ok: false; status: number; error: string };

/** The visit a control drives: its tabs, values and recording. */
export type ControlledVisit = {
	tabs: VisitorTabs;
	/** The tab emulates a touch screen (a phone capture). */
	touch: boolean;
	values: Record<SyntheticField, string>;
	/** Record the visitor's tab as the visit's next step now; false when it shows what the last step did, or the visit holds all the steps it may. */
	recordStep(): Promise<boolean>;
	/** An action for the visit's record and live log. */
	onAction(action: VisitAgentAction): void;
	/** A person started or stopped driving: the visit's clock stops meanwhile. */
	onDriving(driving: boolean): void;
};

type Controller = { viewer: string; label: string; since: number; lastInputAt: number; reportedIdleAt: number };
/** Where a control tells viewers what changed. */
type ControlPublish = (event: VisitControlEvent) => void;

/** How a viewer is named to others: never by its id, which is its key to the controls. */
export function viewerLabel(viewer: string): string {
	return `Viewer ${createHash("sha256").update(viewer).digest("hex").slice(0, 4)}`;
}

/** A tab as viewers see it. */
async function describeTab(targetId: string, page: Pick<Page, "url" | "title">, active: boolean): Promise<VisitControlEvent["tabs"][number]> {
	return { targetId, url: page.url(), title: (await page.title().catch(() => "")).slice(0, 200), active };
}

function modifierPrefix(modifiers: number): string {
	return `${modifiers & CTRL ? "Ctrl+" : ""}${modifiers & META ? "Cmd+" : ""}${modifiers & ALT ? "Alt+" : ""}${modifiers & SHIFT ? "Shift+" : ""}`;
}

export class VisitControl {
	readonly screen = new LiveScreen();
	readonly #publish: ControlPublish;
	readonly #listeners = new Set<ControlPublish>();
	readonly #run = randomUUID();
	#seq = 0;
	#mode: VisitMode;
	#status?: string;
	/** The tab shown while the site loads, before the agent's visit is attached. */
	#loading?: ScreenTab;
	#visit?: ControlledVisit;
	#controller?: Controller;
	/** A turn being handed back: nobody takes over until the agent has its account. */
	#handingBack?: Promise<void>;
	#agentEnded = false;
	#ending?: Promise<void>;
	/** Notes for the agent's next turn: messages, and the account of a person's turn. */
	readonly #notes: string[] = [];
	/** The tab a person left the visitor on, for the agent to go on in. */
	#leftOn?: string;
	#turn = new AbortController();
	#resumed?: PromiseWithResolvers<void>;
	#humanMs = 0;
	#humanActions = 0;
	/** The actions of the current person's turn, for the account the agent gets. */
	#turnActions: VisitAgentAction[] = [];
	#actionCount = 0;
	readonly #pointer: PointerState = {};
	#press?: { x: number; y: number; element?: string; moved: boolean };
	/** Typing in one field, recorded once it ends. */
	#typing?: VisitAgentAction;
	#scrolling?: { action: VisitAgentAction; at: number; dy: number };
	readonly #inputTimes: number[] = [];
	readonly #messagedAt = new Map<string, number>();
	readonly #messageTimes: number[] = [];
	/** Inputs run one at a time, in the order they came. */
	#queue: Promise<unknown> = Promise.resolve();
	#watchdog?: ReturnType<typeof setInterval>;
	/** The visit's tabs as viewers last heard of them. */
	#tabs: VisitControlEvent["tabs"] = [];

	readonly steering: TaskSteering = {
		checkpoint: async (signal) => {
			if (this.#mode === "pausing") this.#enterHuman();
			while (this.#mode === "human" && this.#resumed && !signal.aborted) {
				const resumed = this.#resumed.promise;
				await new Promise<void>((resolve, reject) => {
					const onAbort = () => reject(signal.reason);
					signal.addEventListener("abort", onAbort, { once: true });
					void resumed.then(() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					});
				});
			}
			const targetId = this.#leftOn;
			this.#leftOn = undefined;
			return { notes: this.#notes.splice(0), ...(targetId ? { targetId } : {}) };
		},
		// A turn that starts while a person takes over is over before it began.
		turn: () => {
			this.#turn = new AbortController();
			if (this.holding) this.#turn.abort();
			return this.#turn.signal;
		},
	};

	constructor(readonly key: string, publish: ControlPublish, options: VisitControlOptions = {}, private readonly now: () => number = Date.now) {
		this.#publish = publish;
		this.#mode = options.mode ?? "agent";
		this.#status = options.status;
		// A loading visit is live from its start: viewers hear of it before any browser opened.
		if (this.#mode === "loading") this.publishState();
	}

	get mode(): VisitMode {
		return this.#mode;
	}

	/** A person drives, or is about to: the visit goes on until they hand back. */
	get holding(): boolean {
		return this.#mode === "human" || this.#mode === "pausing";
	}

	/** Whether a person took the browser over during this visit. */
	tookOver = false;

	/** Say what happens now (or nothing, with `undefined`). */
	setStatus(status: string | undefined): void {
		if (this.#mode === "ended" || status === this.#status) return;
		this.#status = status;
		this.publishState();
	}

	/**
	 * While the site loads: show this tab (a new exit's browser), or nothing
	 * while one exit's browser closed and the next has not opened, and say
	 * what happens. Viewers stay connected throughout; `attach` hands over to
	 * the agent's visit. Does nothing once the visit is no longer loading.
	 */
	async watchTab(tab: ScreenTab | undefined, status?: string): Promise<void> {
		if (this.#mode !== "loading") return;
		this.#loading = tab;
		if (status !== undefined) this.#status = status;
		this.#tabs = tab ? [{ targetId: tab.session.id(), url: tab.page.url(), title: "", active: true }] : [];
		this.publishState();
		await (tab ? this.screen.show(tab) : this.screen.clear());
	}

	/** The visit is under way: people may watch and drive it from now on. A loading visit's viewers watch on. */
	attach(visit: ControlledVisit): void {
		if (this.#mode === "ended") return;
		if (this.#mode === "loading") {
			this.#mode = "agent";
			this.#status = undefined;
			this.#loading = undefined;
			this.#tabs = [];
		}
		this.#visit = visit;
		this.#watchdog = setInterval(() => void this.expireTurn(), 1_000);
		void this.screen.show(this.#screenTab(visit.tabs.active()) ?? { session: visit.tabs.first.session, page: visit.tabs.first.page! });
		this.publishState();
	}

	/** The agent's walk ended: a person who drives may go on; otherwise the visit ends. */
	agentEnded(): void {
		this.#agentEnded = true;
		if (this.#mode === "pausing") this.#enterHuman();
		this.publishState();
	}

	/** The visit is over, from now on: whoever drives is let go, and nobody takes over again. */
	end(): Promise<void> {
		if (this.#mode === "ended") return this.#ending ?? Promise.resolve();
		this.#mode = "ended";
		this.#status = undefined;
		this.#loading = undefined;
		clearInterval(this.#watchdog);
		this.#ending = (async () => {
			if (this.#controller) await this.#handBack(this.#controller, "the visit ended");
			await this.#handingBack;
			this.publishState();
			this.#visit = undefined;
			await this.screen.close();
		})();
		return this.#ending;
	}

	/** The screen follows the visitor's tab, and viewers hear of tabs that opened, closed or moved on (or of the loading tab's page). Called on every poll of the visit. */
	async follow(): Promise<void> {
		const visit = this.#visit;
		const loading = this.#loading;
		if (this.#mode === "ended") return;
		let tabs: VisitControlEvent["tabs"];
		if (visit) {
			const tab = this.#screenTab(visit.tabs.active());
			if (tab) await this.screen.show(tab);
			const active = visit.tabs.active();
			tabs = await Promise.all(visit.tabs.tabs().filter((candidate) => !candidate.closed && candidate.page).map((candidate) => describeTab(candidate.targetId, candidate.page!, candidate === active)));
		} else if (loading) {
			tabs = [await describeTab(loading.session.id(), loading.page, true)];
		} else return;
		// The visit moved on meanwhile (another exit's tab, the agent's visit, its end): this read is stale.
		if (this.mode === "ended" || this.#visit !== visit || this.#loading !== loading) return;
		if (JSON.stringify(tabs) === JSON.stringify(this.#tabs)) return;
		this.#tabs = tabs;
		this.publishState();
	}

	/** A viewer takes the browser over; its id (random, never shown) is its key to the controls while it drives. */
	take(viewer: string): ControlResult {
		if (this.#mode === "loading") return { ok: false, status: 409, error: "The site is still loading; take over unlocks once the agent starts." };
		if (!this.#visit || this.#mode === "ended") return { ok: false, status: 409, error: "The visit is not live." };
		if (this.#controller) {
			if (this.#controller.viewer === viewer) return { ok: true };
			return { ok: false, status: 409, error: `${this.#controller.label} is driving the browser.` };
		}
		if (this.#handingBack) return { ok: false, status: 409, error: "The browser is being handed back to the agent; try again in a moment." };
		if (this.#agentEnded) return { ok: false, status: 409, error: "The visit is finishing." };
		if (this.#humanMs >= HUMAN_TOTAL_MS) return { ok: false, status: 429, error: `People drove this visit for ${HUMAN_TOTAL_MS / 60_000} minutes already.` };
		if (this.#humanActions >= MAX_HUMAN_ACTIONS) return { ok: false, status: 429, error: "People did as much in this visit as one visit records." };
		const now = this.now();
		this.#controller = { viewer, label: viewerLabel(viewer), since: now, lastInputAt: now, reportedIdleAt: now };
		this.tookOver = true;
		this.#turnActions = [];
		this.#resumed = Promise.withResolvers<void>();
		this.#mode = "pausing";
		this.#turn.abort();
		this.#visit.onDriving(true);
		this.screen.setDriving(true);
		this.#record("takeover", `${this.#controller.label} took over the browser`);
		this.publishState();
		return { ok: true };
	}

	/** Whether this viewer drives the browser now (or is about to, while the agent finishes its action). */
	drives(viewer: string): boolean {
		return this.#controller?.viewer === viewer;
	}

	async release(viewer: string, note?: string): Promise<ControlResult> {
		const controller = this.#authorized(viewer);
		if (!controller) return { ok: false, status: 403, error: "You are not driving the browser." };
		await this.#handBack(controller, "they handed it back", note?.trim().slice(0, MAX_MESSAGE));
		return { ok: true };
	}

	/** Anyone watching may write to the agent; it reads the message at its next turn. */
	message(viewer: string, text: string): ControlResult {
		const message = text.trim().slice(0, MAX_MESSAGE);
		if (!message) return { ok: false, status: 400, error: "The message is empty." };
		if (this.#mode === "loading") return { ok: false, status: 409, error: "The agent has not started walking the site yet." };
		if (!this.#visit || this.#agentEnded || this.#mode === "ended") return { ok: false, status: 409, error: "The agent is no longer walking the site." };
		const now = this.now();
		while (this.#messageTimes.length && now - this.#messageTimes[0]! >= 60_000) this.#messageTimes.shift();
		if (now - (this.#messagedAt.get(viewer) ?? -Infinity) < MESSAGE_INTERVAL_MS || this.#messageTimes.length >= MESSAGES_PER_MINUTE) {
			return { ok: false, status: 429, error: "Wait a moment before the next message." };
		}
		for (const [someone, at] of this.#messagedAt) if (now - at >= MESSAGE_INTERVAL_MS) this.#messagedAt.delete(someone);
		this.#messagedAt.set(viewer, now);
		this.#messageTimes.push(now);
		this.#note(`${viewerLabel(viewer)}, a person watching the visit, writes: ${message}`);
		this.#record("message", `${viewerLabel(viewer)} wrote to the agent: ${message}`, { value: message });
		return { ok: true };
	}

	/** The driver's inputs, in order. */
	input(viewer: string, inputs: readonly LiveInput[]): Promise<ControlResult> {
		const controller = this.#authorized(viewer);
		if (!controller) return Promise.resolve({ ok: false, status: 403, error: "You are not driving the browser." });
		if (this.#mode !== "human") return Promise.resolve({ ok: false, status: 409, error: "The agent is finishing its action; the browser is yours in a moment." });
		const now = this.now();
		while (this.#inputTimes.length && now - this.#inputTimes[0]! > 1_000) this.#inputTimes.shift();
		if (this.#inputTimes.length + inputs.length > INPUTS_PER_SECOND) return Promise.resolve({ ok: false, status: 429, error: "Too many inputs at once." });
		for (let index = 0; index < inputs.length; index += 1) this.#inputTimes.push(now);
		controller.lastInputAt = now;
		if (now - controller.reportedIdleAt >= IDLE_REPORT_MS) {
			controller.reportedIdleAt = now;
			this.publishState();
		}
		const run = this.#queue.then(async () => {
			for (const input of inputs) {
				// A turn handed back (or a visit ended) takes no more of its inputs.
				if (this.#controller !== controller || this.#mode !== "human" || !this.#visit) break;
				await this.#apply(this.#visit, input).catch((error: unknown) => console.warn("A live input failed:", errorText(error)));
			}
			return { ok: true } as const;
		});
		this.#queue = run.catch(() => undefined);
		return run;
	}

	/** Hear every control state from now on, until the returned function is called. */
	subscribe(listener: ControlPublish): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Tell every viewer the control state. */
	publishState(): void {
		this.#seq += 1;
		const state = this.state;
		this.#publish(state);
		for (const listener of this.#listeners) listener(state);
	}

	/** The control state as viewers see it now. */
	get state(): VisitControlEvent {
		const visit = this.#visit;
		const active = visit?.tabs.active();
		const controller = this.#controller;
		return {
			type: "browser.control",
			run: this.#run,
			seq: this.#seq,
			mode: this.#mode,
			...(this.#status ? { status: this.#status } : {}),
			...(controller ? {
				controller: controller.label,
				until: new Date(controller.since + Math.min(TAKEOVER_MAX_MS, HUMAN_TOTAL_MS - this.#humanMs)).toISOString(),
				idleUntil: new Date(controller.lastInputAt + TAKEOVER_IDLE_MS).toISOString(),
			} : {}),
			// The tabs as `follow` read them, with the visitor's tab as it is now.
			tabs: this.#viewTabs(visit, active),
			fakeValues: visit?.values ?? {},
			agentRunning: Boolean(visit) && !this.#agentEnded && this.#mode !== "ended",
		};
	}

	/** A turn without input, or one that ran too long, ends on its own; checked every second. The idle clock starts once the agent let go. */
	expireTurn(): Promise<void> {
		const controller = this.#controller;
		if (!controller) return Promise.resolve();
		const now = this.now();
		if (this.#mode === "human" && now - controller.lastInputAt >= TAKEOVER_IDLE_MS) return this.#handBack(controller, `${TAKEOVER_IDLE_MS / 1_000} s without input`);
		if (now - controller.since >= Math.min(TAKEOVER_MAX_MS, HUMAN_TOTAL_MS - this.#humanMs)) return this.#handBack(controller, "its time was up");
		return Promise.resolve();
	}

	#viewTabs(visit: ControlledVisit | undefined, active: VisitorTab | undefined): VisitControlEvent["tabs"] {
		if (!visit) return this.#loading ? this.#tabs : [];
		const tabs = this.#tabs.length
			? this.#tabs
			: visit.tabs.tabs().filter((tab) => !tab.closed && tab.page).map((tab) => ({ targetId: tab.targetId, url: tab.page!.url(), title: "" }));
		return tabs.map((tab) => ({ ...tab, active: tab.targetId === active?.targetId }));
	}

	#screenTab(tab: VisitorTab): ScreenTab | undefined {
		return tab.page ? { session: tab.session, page: tab.page } : undefined;
	}

	#inputTab(visit: ControlledVisit): InputTab {
		return { session: visit.tabs.active().session, touch: visit.touch };
	}

	#authorized(viewer: string): Controller | undefined {
		return this.drives(viewer) ? this.#controller : undefined;
	}

	#enterHuman(): void {
		this.#mode = "human";
		// The person could not act while the agent finished: their idle time starts now.
		if (this.#controller) this.#controller.lastInputAt = this.#controller.reportedIdleAt = this.now();
		this.publishState();
	}

	#note(note: string): void {
		this.#notes.push(note);
		if (this.#notes.length > MAX_NOTES) this.#notes.splice(0, this.#notes.length - MAX_NOTES);
	}

	/**
	 * End the controller's turn: no more of its inputs run, a button still
	 * held is let go, and then the agent gets an account of the turn and goes
	 * on in the tab the person left.
	 */
	#handBack(controller: Controller, why: string, note?: string): Promise<void> {
		if (this.#controller !== controller) return this.#handingBack ?? Promise.resolve();
		this.#controller = undefined;
		const handing = (async () => {
			await this.#queue;
			const visit = this.#visit;
			if (visit) await releasePointer(this.#inputTab(visit), this.#pointer);
			this.#press = undefined;
			this.#finishTyping();
			const now = this.now();
			const took = now - controller.since;
			this.#humanMs += Math.max(MIN_TURN_CHARGE_MS, took);
			const handedBack = why === "they handed it back";
			this.#record("handback", `${controller.label} handed the browser back${handedBack ? "" : ` (${why})`}${note ? `: ${note}` : ""}`, note ? { value: note } : {});
			const active = visit?.tabs.active();
			const done = this.#turnActions.filter((action) => !["takeover", "handback", "message"].includes(action.kind)).slice(-MAX_HANDOFF_ACTIONS);
			this.#note([
				`A person took over the browser for ${Math.max(1, Math.round(took / 1_000))} s and ${handedBack ? "handed it back" : `the turn ended: ${why}`}.`,
				done.length ? `What they did, in order: ${done.map((action) => `${action.text}${this.#typedForAgent(action)}`).join("; ")}.` : "They did nothing in the page.",
				active?.page ? `The visitor's tab now shows ${active.page.url()}.` : "",
				note ? `They add: ${note}` : "",
				"Continue the visit from the page as it is now.",
			].filter(Boolean).join(" "));
			if (active) this.#leftOn = active.targetId;
			const ending = this.#mode === "ended";
			if (!ending) this.#mode = "agent";
			this.#resumed?.resolve();
			this.#resumed = undefined;
			visit?.onDriving(false);
			this.screen.setDriving(false);
			// A visit that ends tells viewers once, as `end` finishes.
			if (!ending) this.publishState();
		})().finally(() => {
			if (this.#handingBack === handing) this.#handingBack = undefined;
		});
		this.#handingBack = handing;
		return handing;
	}

	/** What a person typed, as the agent reads it: a made-up value by its name only, as the agent's own secrets never reach its prompt. */
	#typedForAgent(action: VisitAgentAction): string {
		if (action.kind !== "type" || !action.value) return "";
		if (action.typedAs) return "";
		const value = [...action.value];
		return ` (typed ${JSON.stringify(value.length > MAX_HANDOFF_VALUE ? `${value.slice(0, MAX_HANDOFF_VALUE).join("")}…` : action.value)})`;
	}

	/** A person's action; one still going on (typing in a field) is announced once it ends. */
	#record(kind: string, text: string, extra: Partial<VisitAgentAction> = {}, ongoing = false): VisitAgentAction {
		this.#actionCount += 1;
		const action: VisitAgentAction = { id: `p${this.#actionCount}`, kind, text, actor: "human", at: new Date(this.now()).toISOString(), ...extra };
		this.#turnActions.push(action);
		if (!ongoing) this.#announce(action);
		return action;
	}

	#announce(action: VisitAgentAction): void {
		this.#humanActions += 1;
		this.#visit?.onAction(action);
		// A person who did as much as a visit records hands back.
		if (this.#humanActions >= MAX_HUMAN_ACTIONS && this.#controller) void this.#handBack(this.#controller, "it did as much as one visit records");
	}

	/** Typing in one field ends: its record holds everything typed there. */
	#finishTyping(): void {
		if (this.#typing) this.#announce(this.#typing);
		this.#typing = undefined;
	}

	/** Text typed into the focused field, joined with what was typed there just before. */
	async #typed(visit: ControlledVisit, text: string, how: { fake?: SyntheticField; erase?: boolean } = {}): Promise<void> {
		const tab = visit.tabs.active();
		if (how.fake) {
			this.#finishTyping();
			const field = await describeFocusedElement(tab.session);
			this.#record("type", `Entered the made-up ${how.fake} into ${field ?? "the focused field"}`, { value: text, typedAs: `made-up ${how.fake}`, ...(field ? { selector: field } : {}) });
			return;
		}
		if (this.#typing && !how.erase && [...this.#typing.value ?? ""].length + [...text].length > MAX_TYPED) this.#finishTyping();
		if (!this.#typing) {
			if (how.erase) return;
			const field = await describeFocusedElement(tab.session);
			this.#typing = this.#record("type", `Typed into ${field ?? "the focused field"}`, { value: "", ...(field ? { selector: field } : {}) }, true);
		}
		this.#typing.value = how.erase ? [...this.#typing.value ?? ""].slice(0, -1).join("") : `${this.#typing.value ?? ""}${text}`;
		this.#typing.at = new Date(this.now()).toISOString();
	}

	async #apply(visit: ControlledVisit, input: LiveInput): Promise<void> {
		const tab = visit.tabs.active();
		const page = this.#inputTab(visit);
		switch (input.type) {
			case "pointer": {
				if (input.phase === "down") {
					this.#finishTyping();
					this.#scrolling = undefined;
					// What is under the pointer before the press changes it.
					const element = await describeElementAt(tab.session, input.x, input.y);
					this.#press = { x: input.x, y: input.y, moved: false, ...(element ? { element } : {}) };
				}
				await dispatchPageInput(page, input, this.#pointer);
				if (input.phase === "move" && this.#press) {
					this.#press.moved ||= Math.hypot(input.x - this.#press.x, input.y - this.#press.y) >= DRAG_DISTANCE;
				} else if (input.phase === "up" && this.#press) {
					const press = this.#press;
					this.#press = undefined;
					const target = press.element ?? `the point (${Math.round(press.x)}, ${Math.round(press.y)})`;
					const how = input.button === "right" ? "Right-clicked" : input.button === "middle" ? "Middle-clicked" : input.clickCount > 1 ? "Double-clicked" : "Clicked";
					if (press.moved) this.#record("drag", `Dragged from ${target} to (${Math.round(input.x)}, ${Math.round(input.y)})`, press.element ? { selector: press.element } : {});
					else this.#record("click", `${how} ${target}`, press.element ? { selector: press.element } : {});
				}
				return;
			}
			case "wheel": {
				this.#finishTyping();
				await dispatchPageInput(page, input, this.#pointer);
				const now = this.now();
				if (this.#scrolling && now - this.#scrolling.at < SCROLL_COALESCE_MS) {
					this.#scrolling.at = now;
					this.#scrolling.dy += input.deltaY;
					this.#scrolling.action.text = `Scrolled ${this.#scrolling.dy >= 0 ? "down" : "up"} ${Math.abs(Math.round(this.#scrolling.dy))} px`;
					return;
				}
				const action = this.#record("scroll", `Scrolled ${input.deltaY >= 0 ? "down" : "up"} ${Math.abs(Math.round(input.deltaY))} px`);
				this.#scrolling = { action, at: now, dy: input.deltaY };
				return;
			}
			case "key": {
				if (!keyAllowed(input.key, input.modifiers)) return;
				await dispatchPageInput(page, input, this.#pointer);
				if (input.phase === "up") return;
				const printable = [...input.key].length === 1 && !(input.modifiers & (CTRL | META));
				if (printable) return this.#typed(visit, input.key);
				if (input.key === "Backspace" && this.#typing && !input.modifiers) return this.#typed(visit, "", { erase: true });
				if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(input.key)) return;
				this.#finishTyping();
				this.#record("key", `Pressed ${modifierPrefix(input.modifiers)}${input.key}`);
				return;
			}
			case "text":
				await dispatchPageInput(page, input, this.#pointer);
				return this.#typed(visit, input.text);
			case "fake": {
				const value = visit.values[input.field];
				await dispatchPageInput(page, { type: "text", text: value }, this.#pointer);
				return this.#typed(visit, value, { fake: input.field });
			}
			case "history": {
				this.#finishTyping();
				const { currentIndex, entries } = await tab.session.send("Page.getNavigationHistory");
				const entry = entries[currentIndex + (input.direction === "back" ? -1 : 1)];
				if (!entry) return;
				await tab.session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
				this.#record(input.direction, `Went ${input.direction} to ${entry.url}`);
				return;
			}
			case "reload":
				this.#finishTyping();
				await tab.session.send("Page.reload", {});
				this.#record("reload", `Reloaded ${tab.page?.url() ?? "the page"}`);
				return;
			case "tab": {
				const target = visit.tabs.tabs().find((candidate) => candidate.targetId === input.targetId && !candidate.closed && candidate.page);
				if (!target || target === tab) return;
				this.#finishTyping();
				await releasePointer(page, this.#pointer);
				await visit.tabs.focus(target);
				await this.follow();
				this.#record("tab", `Switched to the tab showing ${target.page!.url()}`);
				return;
			}
			case "capture": {
				this.#finishTyping();
				const url = tab.page?.url() ?? "the page";
				this.#record("capture", await visit.recordStep() ? `Recorded ${url} as a step of the visit` : `Asked to record ${url}; it is unchanged since the last recorded step (or the visit holds all the steps it may)`);
				return;
			}
		}
	}
}

const REGISTRY_KEY = Symbol.for("phishing_reporter.visitControls");
/** The live visits by case, shared by the analysis and the request handlers (Next bundles them apart). */
const registry: Map<string, VisitControl> = ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] ??= new Map()) as Map<string, VisitControl>;

/** A control for a case's visit, which people can reach while it lives; a case runs one visit at a time. */
export function openVisitControl(key: string, publish: ControlPublish, options?: VisitControlOptions): VisitControl {
	const previous = registry.get(key);
	const control = new VisitControl(key, publish, options);
	registry.set(key, control);
	// The previous visit's end reaches viewers after this visit's first state, which viewers would take for the newest: say it again after.
	if (previous) void previous.end().then(() => {
		if (control.mode !== "ended" && control.state.seq > 0) control.publishState();
	}).catch(() => undefined);
	return control;
}

/** Forget a case's control once its visit ended. */
export async function closeVisitControl(control: VisitControl): Promise<void> {
	await control.end();
	if (registry.get(control.key) === control) registry.delete(control.key);
}

export function visitControlOf(key: string): VisitControl | undefined {
	return registry.get(key);
}
