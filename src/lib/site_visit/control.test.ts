import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { VisitorTabs } from "../browser/visitor_tabs";
import type { VisitAgentAction } from "./agent";
import { closeVisitControl, HUMAN_TOTAL_MS, MIN_TURN_CHARGE_MS, openVisitControl, TAKEOVER_IDLE_MS, TAKEOVER_MAX_MS, VisitControl, visitControlOf, viewerLabel, type VisitControlEvent } from "./control";
import { syntheticVisitValues } from "./visit_task";
import { createExfiltrationCanaries } from "../exfiltration/canaries";

const ALICE = "alice-0000000000000000";
const BOB = "bob-00000000000000000000";

/** A CDP session that answers every command and remembers it; `scrolled` is how far its page is scrolled. */
function fakeSession() {
	const sent: Array<{ method: string; params: unknown }> = [];
	const scrolled = { y: 0 };
	const session = Object.assign(new EventEmitter(), {
		sent,
		scrolled,
		send: async (method: string, params?: unknown) => {
			sent.push({ method, params });
			// Typing takes the browser a moment, as it does over a real connection.
			if (method === "Input.insertText") await new Promise((resolve) => setTimeout(resolve, 1));
			if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{ id: 1, url: "https://kit.example/" }, { id: 2, url: "https://kit.example/login" }, { id: 3, url: "https://kit.example/card" }] };
			if (method === "Runtime.evaluate") return { result: { objectId: "focused" } };
			if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: scrolled.y } };
			if (method === "DOM.getNodeForLocation") return { backendNodeId: 7 };
			if (method === "DOM.describeNode") {
				const focused = (params as { objectId?: string }).objectId === "focused";
				return { node: focused
					? { nodeName: "INPUT", localName: "input", attributes: ["id", "email", "name", "email", "type", "email", "placeholder", "Email address"] }
					: { nodeName: "BUTTON", localName: "button", attributes: ["type", "submit"], children: [{ nodeType: 3, nodeValue: " Sign in " }] } };
			}
			return {};
		},
	});
	return session;
}

/** A control attached to a fake visit, with a clock the test moves. */
function attached() {
	const clock = { now: 1_000_000 };
	const events: VisitControlEvent[] = [];
	const actions: VisitAgentAction[] = [];
	const driving: boolean[] = [];
	const session = fakeSession();
	const page = { url: () => "https://kit.example/login", title: async () => "Sign in" };
	const tab = { targetId: "T1", session, page, closed: false };
	const other = { targetId: "T2", session: fakeSession(), page: { url: () => "https://kit.example/popup", title: async () => "Popup" }, closed: false };
	let active: typeof tab = tab;
	const tabs = {
		first: tab,
		active: () => active,
		tabs: () => [tab, other],
		focus: async (target: typeof tab) => { active = target; },
	} as unknown as VisitorTabs;
	const control = new VisitControl("case-1", (event) => events.push(event), () => clock.now);
	let recordedSteps = 0;
	/** Whether the next "record this page" finds a new page. */
	const pageChanged = { value: true };
	const canaries = createExfiltrationCanaries();
	control.attach({
		tabs,
		touch: false,
		values: syntheticVisitValues(canaries),
		recordStep: async () => {
			recordedSteps += 1;
			return pageChanged.value;
		},
		onAction: (action) => { if (!actions.includes(action)) actions.push(action); },
		onDriving: (value) => driving.push(value),
	});
	return { control, clock, events, actions, driving, session, other, canaries, pageChanged, recorded: () => recordedSteps };
}

/** Let the agent reach its checkpoint, as runTask does before each turn. */
async function agentPauses(control: VisitControl) {
	const controller = new AbortController();
	const resumed = control.steering.checkpoint(controller.signal);
	await Promise.resolve();
	return { resumed, notes: resumed.then((result) => result.notes), abort: () => controller.abort(new Error("visit ended")) };
}

describe("who drives a live visit", () => {
	test("one person at a time: the first to take it drives; another is told who; the driver taking again keeps its turn", () => {
		const { control, events } = attached();
		const heard: VisitControlEvent[] = [];
		const unsubscribe = control.subscribe((state) => heard.push(state));
		expect(control.take(ALICE)).toEqual({ ok: true });
		expect(control.take(BOB)).toEqual({ ok: false, status: 409, error: `${viewerLabel(ALICE)} is driving the browser.` });
		expect(control.take(ALICE)).toEqual({ ok: true });
		expect(control.drives(ALICE)).toBe(true);
		expect(control.drives(BOB)).toBe(false);
		expect(control.mode).toBe("pausing");
		// Subscribers hear what the case's stream hears, and `state` is the latest of it.
		expect(heard).toEqual(events.slice(-heard.length));
		expect(control.state).toEqual(events.at(-1)!);
		const before = heard.length;
		unsubscribe();
		control.publishState();
		expect(heard.length).toBe(before);
		expect(events.at(-1)).toMatchObject({ type: "browser.control", mode: "pausing", controller: viewerLabel(ALICE), agentRunning: true });
		// A viewer is named by a hash of its id, never by the id that holds the controls.
		expect(JSON.stringify(events)).not.toContain(ALICE);
	});

	test("taking over interrupts the agent's turn; at its checkpoint the agent waits until the person hands back, then reads their account", async () => {
		const { control, actions, driving, canaries } = attached();
		const turn = control.steering.turn();
		control.take(ALICE);
		expect(turn.aborted).toBe(true);
		const { notes } = await agentPauses(control);
		expect(control.mode).toBe("human");
		let resumed = false;
		void notes.then(() => { resumed = true; });

		await control.input(ALICE, [
			{ type: "pointer", phase: "down", x: 40, y: 50, button: "left", clickCount: 1 },
			{ type: "pointer", phase: "up", x: 41, y: 50, button: "left", clickCount: 1 },
			{ type: "key", phase: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 },
			{ type: "key", phase: "up", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 },
			{ type: "key", phase: "down", key: "x", code: "KeyX", keyCode: 88, modifiers: 0 },
			{ type: "key", phase: "down", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 },
			{ type: "text", text: "lice@corp.example" },
			{ type: "fake", field: "password" },
			{ type: "key", phase: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 },
		]);
		expect(resumed).toBe(false);
		expect(await control.release(ALICE, "  signed in; the card page is next  ")).toEqual({ ok: true });
		const delivered = await notes;
		expect(resumed).toBe(true);
		expect(control.mode).toBe("agent");
		expect(driving).toEqual([true, false]);

		const human = actions.filter((action) => action.actor === "human");
		expect(human.map((action) => [action.kind, action.text, action.value, action.typedAs, action.selector])).toEqual([
			["takeover", `${viewerLabel(ALICE)} took over the browser`, undefined, undefined, undefined],
			["click", 'Clicked button[type=submit] "Sign in"', undefined, undefined, 'button[type=submit] "Sign in"'],
			["type", 'Typed into input#email[name=email][type=email] "Email address"', "alice@corp.example", undefined, 'input#email[name=email][type=email] "Email address"'],
			["type", 'Entered the made-up password into input#email[name=email][type=email] "Email address"', expect.any(String), "made-up password", 'input#email[name=email][type=email] "Email address"'],
			["key", "Pressed Enter", undefined, undefined, undefined],
			["handback", `${viewerLabel(ALICE)} handed the browser back: signed in; the card page is next`, "signed in; the card page is next", undefined, undefined],
		]);
		expect(human.every((action) => action.at && action.id.startsWith("p"))).toBe(true);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("A person took over the browser for 1 s and handed it back.");
		expect(delivered[0]).toContain('Typed into input#email[name=email][type=email] "Email address" (typed "alice@corp.example")');
		expect(delivered[0]).toContain("Pressed Enter");
		expect(delivered[0]).toContain("The visitor's tab now shows https://kit.example/login.");
		expect(delivered[0]).toContain("They add: signed in; the card page is next");
		expect(delivered[0]).not.toContain("took over the browser;");
		// The made-up password is named, never shown to the model, like the agent's own secrets.
		expect(delivered[0]).toContain("Entered the made-up password into");
		expect(delivered[0]).not.toContain(canaries.password);
	});

	test("the browser's own input events reach the tab: a click is a move, a press and a release; Enter carries its text", async () => {
		const { control, session } = attached();
		control.take(ALICE);
		await agentPauses(control);
		session.sent.length = 0;
		await control.input(ALICE, [
			{ type: "pointer", phase: "down", x: 10, y: 20, button: "left", clickCount: 1 },
			{ type: "pointer", phase: "up", x: 10, y: 20, button: "left", clickCount: 1 },
			{ type: "key", phase: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 },
			{ type: "key", phase: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: 4 },
		]);
		const input = session.sent.filter((call) => call.method.startsWith("Input."));
		expect(input).toEqual([
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 10, y: 20, button: "none", buttons: 0 } },
			{ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 1 } },
			{ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 10, y: 20, button: "left", buttons: 0, clickCount: 1 } },
			{ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" } },
			{ method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] } },
		]);
	});

	test("a press that moves is a drag; history, reload, tab switch and recording a page act on the visitor's tab and are recorded", async () => {
		const { control, actions, session, other, recorded, events } = attached();
		control.take(ALICE);
		await agentPauses(control);
		await control.input(ALICE, [
			{ type: "pointer", phase: "down", x: 10, y: 20, button: "left", clickCount: 1 },
			{ type: "pointer", phase: "move", x: 60, y: 20, button: "left", clickCount: 1 },
			{ type: "pointer", phase: "up", x: 200, y: 22, button: "left", clickCount: 1 },
			{ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 300 },
			{ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: 200 },
			{ type: "history", direction: "back" },
			{ type: "reload" },
			{ type: "capture" },
			{ type: "tab", targetId: "T2" },
			{ type: "tab", targetId: "unknown" },
		]);
		expect(session.sent).toContainEqual({ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 60, y: 20, button: "left", buttons: 1 } });
		expect(session.sent).toContainEqual({ method: "Page.navigateToHistoryEntry", params: { entryId: 1 } });
		expect(session.sent).toContainEqual({ method: "Page.reload", params: {} });
		expect(recorded()).toBe(1);
		expect(actions.filter((action) => action.actor === "human").map((action) => action.text)).toEqual([
			`${viewerLabel(ALICE)} took over the browser`,
			'Dragged from button[type=submit] "Sign in" to (200, 22)',
			"Scrolled down 500 px",
			"Went back to https://kit.example/",
			"Reloaded https://kit.example/login",
			"Recorded https://kit.example/login as a step of the visit",
			"Switched to the tab showing https://kit.example/popup",
		]);
		// The next input goes to the tab the person switched to.
		await control.input(ALICE, [{ type: "text", text: "x" }]);
		expect(other.session.sent).toContainEqual({ method: "Input.insertText", params: { text: "x" } });
		expect(events.at(-1)?.tabs).toEqual([
			{ targetId: "T1", url: "https://kit.example/login", title: "Sign in", active: false },
			{ targetId: "T2", url: "https://kit.example/popup", title: "Popup", active: true },
		]);
		// Nothing changed since: the poll tells viewers nothing new.
		const published = events.length;
		await control.follow();
		expect(events).toHaveLength(published);
	});

	test("inputs come only from the driver, wait for the agent to pause, and are limited per second", async () => {
		const { control } = attached();
		expect(await control.input(ALICE, [{ type: "reload" }])).toEqual({ ok: false, status: 403, error: "You are not driving the browser." });
		control.take(ALICE);
		expect(await control.input(BOB, [{ type: "reload" }])).toMatchObject({ ok: false, status: 403 });
		expect(await control.input(ALICE, [{ type: "reload" }])).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("finishing its action") });
		await agentPauses(control);
		const moves = Array.from({ length: 60 }, (_, index) => ({ type: "pointer" as const, phase: "move" as const, x: index, y: 1, button: "left" as const, clickCount: 1 }));
		expect(await control.input(ALICE, moves)).toEqual({ ok: true });
		expect(await control.input(ALICE, moves)).toEqual({ ok: true });
		expect(await control.input(ALICE, moves.slice(0, 1))).toEqual({ ok: false, status: 429, error: "Too many inputs at once." });
		expect(await control.release(BOB)).toMatchObject({ ok: false, status: 403 });
	});

	test("a turn ends after a minute without input, after ten minutes in any case, and people drive one visit thirty minutes at most", async () => {
		const { control, clock, actions } = attached();
		control.take(ALICE);
		const first = await agentPauses(control);
		clock.now += TAKEOVER_IDLE_MS - 1;
		await control.expireTurn();
		expect(control.mode).toBe("human");
		await control.input(ALICE, [{ type: "reload" }]);
		clock.now += TAKEOVER_IDLE_MS;
		await control.expireTurn();
		expect(control.mode).toBe("agent");
		expect(actions.at(-1)?.text).toBe(`${viewerLabel(ALICE)} handed the browser back (60 s without input)`);
		expect((await first.notes)[0]).toContain("the turn ended: 60 s without input");

		// Busy turns end at ten minutes; the time adds up across turns.
		for (let turn = 0; turn < 2; turn += 1) {
			control.take(BOB);
			await agentPauses(control);
			for (let minute = 0; minute < 10; minute += 1) {
				clock.now += 59_000;
				await control.input(BOB, [{ type: "reload" }]);
				await control.expireTurn();
			}
			clock.now += TAKEOVER_MAX_MS - 590_000;
			await control.expireTurn();
			expect(control.mode).toBe("agent");
		}
		expect(actions.at(-1)?.text).toBe(`${viewerLabel(BOB)} handed the browser back (its time was up)`);
		// 2 min + 10 + 10 so far: the last turn may only run for the 8 minutes left.
		control.take(ALICE);
		await agentPauses(control);
		const started = clock.now;
		while (control.mode !== "agent") {
			clock.now += 30_000;
			await control.input(ALICE, [{ type: "reload" }]);
			await control.expireTurn();
		}
		// About 22 minutes were used: the turn ends once the rest is used up, at the first check after.
		expect(clock.now - started).toBeGreaterThanOrEqual(HUMAN_TOTAL_MS - 22 * 60_000);
		expect(clock.now - started).toBeLessThanOrEqual(HUMAN_TOTAL_MS - 22 * 60_000 + 30_000);
		expect(control.take(BOB)).toEqual({ ok: false, status: 429, error: "People drove this visit for 30 minutes already." });
	});

	test("anyone watching may write to the agent, one message every two seconds, delivered at its next turn", async () => {
		const { control, clock, actions } = attached();
		expect(control.message(BOB, "   ")).toEqual({ ok: false, status: 400, error: "The message is empty." });
		expect(control.message(BOB, "Click the second button, the first is a decoy")).toEqual({ ok: true });
		expect(control.message(BOB, "again")).toEqual({ ok: false, status: 429, error: "Wait a moment before the next message." });
		clock.now += 2_000;
		expect(control.message(ALICE, "x".repeat(900))).toEqual({ ok: true });
		const { notes } = await control.steering.checkpoint(new AbortController().signal);
		expect(notes).toEqual([
			`${viewerLabel(BOB)}, a person watching the visit, writes: Click the second button, the first is a decoy`,
			`${viewerLabel(ALICE)}, a person watching the visit, writes: ${"x".repeat(500)}`,
		]);
		expect(await control.steering.checkpoint(new AbortController().signal)).toEqual({ notes: [] });
		expect(actions.map((action) => [action.kind, action.actor])).toEqual([["message", "human"], ["message", "human"]]);
		control.agentEnded();
		clock.now += 5_000;
		expect(control.message(BOB, "too late")).toMatchObject({ ok: false, status: 409 });
	});

	test("when the agent ends while a person takes over, they drive on; nobody can take a visit that is finishing or over", async () => {
		const { control, events } = attached();
		control.take(ALICE);
		control.agentEnded();
		expect(control.mode).toBe("human");
		expect(control.holding).toBe(true);
		expect(await control.input(ALICE, [{ type: "reload" }])).toEqual({ ok: true });
		await control.release(ALICE);
		expect(control.holding).toBe(false);
		expect(control.take(BOB)).toEqual({ ok: false, status: 409, error: "The visit is finishing." });
		await control.end();
		expect(control.take(BOB)).toEqual({ ok: false, status: 409, error: "The visit is not live." });
		expect(events.at(-1)).toMatchObject({ mode: "ended", agentRunning: false });
	});

	test("a visit that ends while someone drives hands the browser back and lets a waiting agent go", async () => {
		const { control, actions } = attached();
		control.take(ALICE);
		const { notes } = await agentPauses(control);
		await control.end();
		expect((await notes)[0]).toContain("the turn ended: the visit ended");
		expect(actions.at(-1)?.text).toBe(`${viewerLabel(ALICE)} handed the browser back (the visit ended)`);
	});

	test("an agent waiting at its checkpoint stops with the visit's signal", async () => {
		const { control } = attached();
		control.take(ALICE);
		const { notes, abort } = await agentPauses(control);
		abort();
		await expect(notes).rejects.toThrow("visit ended");
	});

	test("handing back lets queued inputs go unrun, waits for the one running, and lets go of a held button before the agent goes on", async () => {
		const { control, session, actions } = attached();
		control.take(ALICE);
		const { notes } = await agentPauses(control);
		// A press, a drag move, then a hand-back before the rest of the batch: the button is let go.
		await control.input(ALICE, [
			{ type: "pointer", phase: "down", x: 10, y: 20, button: "left", clickCount: 1 },
			{ type: "pointer", phase: "move", x: 30, y: 20, button: "left", clickCount: 1 },
		]);
		const running = control.input(ALICE, Array.from({ length: 40 }, () => ({ type: "text" as const, text: "z" })));
		// Let the batch start before the hand-back cuts it short.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const handedBack = control.release(ALICE);
		await running;
		await handedBack;
		await notes;
		const input = session.sent.filter((call) => call.method.startsWith("Input."));
		expect(input.at(-1)).toEqual({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 30, y: 20, button: "left", buttons: 0, clickCount: 1 } });
		expect(input.filter((call) => call.method === "Input.insertText").length).toBeLessThan(40);
		// Nothing of the old turn is recorded after its hand-back.
		expect(actions.at(-1)?.kind).toBe("handback");
	});

	test("a turn that starts while a person takes over is over at once; a takeover while one is handed back waits", async () => {
		const { control } = attached();
		control.take(ALICE);
		expect(control.steering.turn().aborted).toBe(true);
		const { resumed } = await agentPauses(control);
		const handing = control.release(ALICE);
		expect(control.take(BOB)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("handed back") });
		await handing;
		await resumed;
		expect(control.steering.turn().aborted).toBe(false);
		expect(control.take(BOB)).toMatchObject({ ok: true });
	});

	test("the idle clock starts once the agent let go, not while it finished its action", async () => {
		const { control, clock } = attached();
		control.take(ALICE);
		clock.now += TAKEOVER_IDLE_MS * 2;
		await control.expireTurn();
		expect(control.mode).toBe("pausing");
		await agentPauses(control);
		clock.now += TAKEOVER_IDLE_MS - 1;
		await control.expireTurn();
		expect(control.mode).toBe("human");
		clock.now += 1;
		await control.expireTurn();
		expect(control.mode).toBe("agent");
	});

	test("the agent goes on in the tab the person left it on; a turn counts at least fifteen seconds", async () => {
		const { control, clock } = attached();
		for (let turn = 0; turn < HUMAN_TOTAL_MS / MIN_TURN_CHARGE_MS; turn += 1) {
			control.take(ALICE);
			const { resumed } = await agentPauses(control);
			if (turn === 0) await control.input(ALICE, [{ type: "tab", targetId: "T2" }]);
			await control.release(ALICE);
			const result = await resumed;
			expect(result.targetId).toBe(turn === 0 ? "T2" : "T2");
			clock.now += 1_000;
		}
		// Taking over and handing back at once cannot stall the agent forever.
		expect(control.take(ALICE)).toMatchObject({ ok: false, status: 429 });
	});

	test("Ctrl or Cmd shortcuts other than editing never reach the page; Alt, Shift and the middle button are named; Backspace removes whole characters", async () => {
		const { control, session, actions } = attached();
		control.take(ALICE);
		await agentPauses(control);
		session.sent.length = 0;
		await control.input(ALICE, [
			{ type: "key", phase: "down", key: "p", code: "KeyP", keyCode: 80, modifiers: 2 },
			{ type: "key", phase: "down", key: "o", code: "KeyO", keyCode: 79, modifiers: 4 },
			{ type: "key", phase: "down", key: "Z", code: "KeyZ", keyCode: 90, modifiers: 4 | 8 },
			{ type: "key", phase: "down", key: "Tab", code: "Tab", keyCode: 9, modifiers: 1 | 8 },
			{ type: "pointer", phase: "down", x: 5, y: 5, button: "middle", clickCount: 1 },
			{ type: "pointer", phase: "up", x: 5, y: 5, button: "middle", clickCount: 1 },
			{ type: "text", text: "pay 👍🏽" },
			{ type: "key", phase: "down", key: "Backspace", code: "Backspace", keyCode: 8, modifiers: 0 },
			{ type: "key", phase: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 },
		]);
		const keys = session.sent.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => call.params as { key: string; commands?: string[] });
		expect(keys.map((key) => [key.key, key.commands])).toEqual([["Z", ["redo"]], ["Tab", undefined], ["Backspace", undefined], ["Enter", undefined]]);
		expect(session.sent).toContainEqual({ method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 5, y: 5, button: "middle", buttons: 4, clickCount: 1 } });
		expect(actions.filter((action) => action.actor === "human").map((action) => [action.kind, action.text, action.value])).toEqual([
			["takeover", `${viewerLabel(ALICE)} took over the browser`, undefined],
			["key", "Pressed Cmd+Shift+Z", undefined],
			["key", "Pressed Alt+Shift+Tab", undefined],
			["click", 'Middle-clicked button[type=submit] "Sign in"', undefined],
			["type", 'Typed into input#email[name=email][type=email] "Email address"', "pay 👍"],
			["key", "Pressed Enter", undefined],
		]);
	});

	test("the element under the pointer is found on a scrolled page, before the press changes it", async () => {
		const { control, session } = attached();
		control.take(ALICE);
		await agentPauses(control);
		session.scrolled.y = 1_200;
		session.sent.length = 0;
		await control.input(ALICE, [{ type: "pointer", phase: "down", x: 40.4, y: 50.6, button: "left", clickCount: 1 }]);
		const methods = session.sent.map((call) => call.method);
		expect(methods.indexOf("DOM.getNodeForLocation")).toBeLessThan(methods.indexOf("Input.dispatchMouseEvent"));
		expect(session.sent).toContainEqual({ method: "DOM.getNodeForLocation", params: { x: 40, y: 1_251, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false } });
	});

	test("a very long typing run is split into records of 2,000 characters; asking to record an unchanged page says so", async () => {
		const { control, actions, pageChanged } = attached();
		control.take(ALICE);
		await agentPauses(control);
		await control.input(ALICE, [{ type: "text", text: "a".repeat(1_500) }, { type: "text", text: "b".repeat(1_500) }]);
		pageChanged.value = false;
		await control.input(ALICE, [{ type: "capture" }]);
		const typed = actions.filter((action) => action.kind === "type");
		expect(typed.map((action) => action.value)).toEqual(["a".repeat(1_500), "b".repeat(1_500)]);
		expect(actions.at(-1)?.text).toBe("Asked to record https://kit.example/login; it is unchanged since the last recorded step (or the visit holds all the steps it may)");
	});

	test("messages from everyone are limited per minute; the agent gets the newest twenty notes", async () => {
		const { control, clock } = attached();
		const results = Array.from({ length: 25 }, (_, index) => control.message(`viewer-${String(index).padStart(16, "0")}`, `note ${index}`).ok);
		expect(results.filter(Boolean)).toHaveLength(20);
		clock.now += 60_000;
		expect(control.message("viewer-late-000000000000", "after a minute").ok).toBe(true);
		const { notes } = await control.steering.checkpoint(new AbortController().signal);
		expect(notes).toHaveLength(20);
		expect(notes.at(-1)).toContain("after a minute");
		expect(notes[0]).toContain("note 1");
	});

	test("the registry holds one control per case, reachable by every handler, until its visit ends", async () => {
		const first = openVisitControl("case-registry", () => undefined);
		expect(visitControlOf("case-registry")).toBe(first);
		const second = openVisitControl("case-registry", () => undefined);
		expect(first.mode).toBe("ended");
		expect(visitControlOf("case-registry")).toBe(second);
		await closeVisitControl(first);
		expect(visitControlOf("case-registry")).toBe(second);
		await closeVisitControl(second);
		expect(visitControlOf("case-registry")).toBeUndefined();
	});
});
