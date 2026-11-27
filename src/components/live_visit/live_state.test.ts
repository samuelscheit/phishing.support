import { describe, expect, test } from "bun:test";

import { driverStatus, EMPTY_LIVE_EVENTS, fieldLabel, formatCountdown, isLive, MAX_LIVE_ENTRIES, reduceLiveEvent, turnDeadline, type LiveControl, type LiveEvents } from "./live_state";

const control = (overrides: Partial<LiveControl> = {}): LiveControl => ({ run: "r1", seq: 1, mode: "agent", tabs: [], fakeValues: {}, agentRunning: true, ...overrides });
const fold = (messages: unknown[], from: LiveEvents = EMPTY_LIVE_EVENTS) => messages.reduce<LiveEvents>(reduceLiveEvent, from);

describe("reduceLiveEvent", () => {
	test("logs steps, actions with their actor, and downloads", () => {
		const state = fold([
			{ type: "browser.step", index: 0, url: "https://a.test/", title: "Sign in" },
			{ type: "browser.action", kind: "click", text: "Clicked Next", actor: "agent" },
			{ type: "browser.action", kind: "type", text: "Typed into input#email", actor: "human" },
			{ type: "browser.action", kind: "click", text: "No actor" },
			{ type: "browser.download", fileName: "x.exe", url: "https://a.test/x.exe" },
		]);
		expect(state.entries).toEqual([
			{ kind: "step", url: "https://a.test/", title: "Sign in" },
			{ kind: "action", text: "Clicked Next", actionKind: "click", actor: "agent" },
			{ kind: "action", text: "Typed into input#email", actionKind: "type", actor: "human" },
			{ kind: "action", text: "No actor", actionKind: "click", actor: "agent" },
			{ kind: "download", fileName: "x.exe", url: "https://a.test/x.exe" },
		]);
	});

	test("keeps the newest entries only", () => {
		const state = fold(Array.from({ length: MAX_LIVE_ENTRIES + 3 }, (_, index) => ({ type: "browser.action", kind: "click", text: String(index), actor: "agent" })));
		expect(state.entries).toHaveLength(MAX_LIVE_ENTRIES);
		expect(state.entries[0]).toMatchObject({ text: "3" });
	});

	test("a new connection's replay starts over", () => {
		const replayed = [{ type: "browser.action", kind: "click", text: "Clicked", actor: "agent" }, { type: "browser.control", run: "r1", seq: 1, mode: "agent", tabs: [], fakeValues: {}, agentRunning: true }];
		const state = fold([{ type: "connected" }, ...replayed, { type: "connected" }, ...replayed]);
		expect(state.entries).toHaveLength(1);
		expect(state.control?.mode).toBe("agent");
	});

	test("a reconnect whose replay lacks the control state keeps the last one", () => {
		const state = fold([{ type: "browser.control", run: "r1", seq: 2, mode: "human", controller: "Viewer ab12", tabs: [], fakeValues: {}, agentRunning: true }, { type: "connected" }, { type: "browser.action", kind: "click", text: "x", actor: "human" }]);
		expect(state.control?.mode).toBe("human");
		expect(state.entries).toHaveLength(1);
		expect(isLive(state)).toBe(true);
	});

	test("the last control state is current, cleaned of anything malformed", () => {
		const state = fold([
			{ type: "browser.control", run: "r1", seq: 3, mode: "agent", tabs: [], fakeValues: {}, agentRunning: true },
			{
				type: "browser.control", run: "r1", seq: 4, mode: "human", controller: "Viewer ab12", until: "2026-01-01T00:10:00.000Z", idleUntil: "2026-01-01T00:01:00.000Z",
				tabs: [{ targetId: "t1", url: "https://a.test/", title: "", active: true }, { url: "no id" }, "junk"],
				fakeValues: { email: "x@y.test", password: 42, phone: "" },
				agentRunning: true,
			},
		]);
		expect(state.control).toEqual({
			run: "r1", seq: 4, mode: "human", controller: "Viewer ab12", until: "2026-01-01T00:10:00.000Z", idleUntil: "2026-01-01T00:01:00.000Z",
			tabs: [{ targetId: "t1", url: "https://a.test/", title: "", active: true }],
			fakeValues: { email: "x@y.test" },
			agentRunning: true,
		});
	});

	test("a state heard late on the other channel (stream or socket) never replaces a newer one; a new visit's states do", () => {
		const state = (run: string, seq: number, mode: string) => ({ type: "browser.control", run, seq, mode, controller: "Viewer ab12", tabs: [], fakeValues: {}, agentRunning: true });
		const socketFirst = fold([state("r1", 1, "agent"), state("r1", 2, "pausing"), state("r1", 3, "human"), state("r1", 2, "pausing"), state("r1", 3, "human")]);
		expect(socketFirst.control).toMatchObject({ seq: 3, mode: "human" });
		// The socket's state on connect repeats the newest; nothing changes.
		expect(fold([state("r1", 3, "human")], socketFirst)).toBe(socketFirst);
		// A visit run again for the case starts its own count.
		expect(fold([state("r2", 1, "agent")], socketFirst).control).toMatchObject({ run: "r2", seq: 1, mode: "agent" });
	});

	test("a loading visit is live from its first state, with what happens; its states carry on into the agent's visit", () => {
		const state = (seq: number, mode: string, extra: Record<string, unknown> = {}) => ({ type: "browser.control", run: "r1", seq, mode, tabs: [], fakeValues: {}, agentRunning: mode !== "loading", ...extra });
		const loading = fold([{ type: "connected" }, state(1, "loading", { status: "Starting browser via residential exit…" })]);
		expect(isLive(loading)).toBe(true);
		expect(loading.control).toEqual({ run: "r1", seq: 1, mode: "loading", status: "Starting browser via residential exit…", tabs: [], fakeValues: {}, agentRunning: false });
		const switched = fold([state(2, "loading", { status: "Residential exit failed (timeout), trying Tor exit…" })], loading);
		expect(switched.control?.status).toBe("Residential exit failed (timeout), trying Tor exit…");
		// A status that is not text, or empty, is none.
		expect(fold([state(3, "loading", { status: 42 })], switched).control).not.toHaveProperty("status");
		expect(fold([state(3, "loading", { status: "" })], switched).control).not.toHaveProperty("status");
		const walking = fold([state(4, "agent")], switched);
		expect(walking.control).toMatchObject({ mode: "agent", agentRunning: true });
		expect(walking.control).not.toHaveProperty("status");
		expect(isLive(walking)).toBe(true);
		// A late copy of a loading state (the other channel) never takes the agent's visit back.
		expect(fold([state(2, "loading", { status: "late" })], walking)).toBe(walking);
		expect(isLive(fold([state(5, "ended")], walking))).toBe(false);
	});

	test("ignores an unknown mode, unknown types and non-objects", () => {
		const start = fold([{ type: "browser.control", run: "r1", seq: 5, mode: "agent", tabs: [], fakeValues: {}, agentRunning: true }]);
		expect(fold([{ type: "browser.control", run: "r1", seq: 6, mode: "dancing" }, { type: "response.delta" }, null, "x", [1]], start)).toBe(start);
	});

	test("a finished analysis ends the live visit whatever its last control state", () => {
		const running = fold([{ type: "browser.control", run: "r1", seq: 7, mode: "human", tabs: [], fakeValues: {}, agentRunning: true }]);
		expect(isLive(running)).toBe(true);
		expect(isLive(fold([{ type: "analysis.step", step: "visiting", progress: 40 }], running))).toBe(true);
		expect(isLive(fold([{ type: "analysis.step", step: "completed" }], running))).toBe(false);
		expect(isLive(fold([{ type: "analysis.step", step: "x", progress: 100 }], running))).toBe(false);
		expect(isLive(fold([{ type: "browser.control", run: "r1", seq: 8, mode: "ended", tabs: [], fakeValues: {}, agentRunning: false }], running))).toBe(false);
		expect(isLive(EMPTY_LIVE_EVENTS)).toBe(false);
	});
});

describe("driverStatus", () => {
	test("names who drives; the socket's `you` alone says whether it is this viewer", () => {
		expect(driverStatus(control({ mode: "loading", agentRunning: false, status: "Loading page via Tor exit…" }), false)).toEqual({ kind: "loading", status: "Loading page via Tor exit…" });
		expect(driverStatus(control({ mode: "loading", agentRunning: false }), true)).toEqual({ kind: "loading" });
		expect(driverStatus(control(), false)).toEqual({ kind: "agent" });
		expect(driverStatus(control({ agentRunning: false }), false)).toEqual({ kind: "finishing" });
		expect(driverStatus(control({ mode: "ended" }), true)).toEqual({ kind: "ended" });
		expect(driverStatus(undefined, false)).toEqual({ kind: "ended" });
		expect(driverStatus(control({ mode: "human", controller: "Viewer ab12" }), true)).toEqual({ kind: "you" });
		expect(driverStatus(control({ mode: "human", controller: "Viewer cd34" }), false)).toEqual({ kind: "other", label: "Viewer cd34" });
		expect(driverStatus(control({ mode: "pausing", controller: "Viewer ab12" }), true)).toEqual({ kind: "pausing", mine: true, label: "Viewer ab12" });
		expect(driverStatus(control({ mode: "pausing", controller: "Viewer cd34" }), false)).toEqual({ kind: "pausing", mine: false, label: "Viewer cd34" });
	});
});

describe("turnDeadline", () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");

	test("the sooner of idle and limit while a person drives", () => {
		expect(turnDeadline(control({ mode: "human", idleUntil: "2026-01-01T00:01:00.000Z", until: "2026-01-01T00:10:00.000Z" }), now)).toEqual({ reason: "idle", ms: 60_000 });
		expect(turnDeadline(control({ mode: "human", idleUntil: "2026-01-01T00:01:00.000Z", until: "2026-01-01T00:00:30.000Z" }), now)).toEqual({ reason: "limit", ms: 30_000 });
		expect(turnDeadline(control({ mode: "human", until: "2026-01-01T00:00:30.000Z" }), now)).toEqual({ reason: "limit", ms: 30_000 });
	});

	test("never negative, nothing without a person or deadlines", () => {
		expect(turnDeadline(control({ mode: "human", idleUntil: "2025-12-31T23:59:00.000Z" }), now)).toEqual({ reason: "idle", ms: 0 });
		expect(turnDeadline(control({ mode: "human" }), now)).toBeUndefined();
		expect(turnDeadline(control({ mode: "human", idleUntil: "garbage" }), now)).toBeUndefined();
		expect(turnDeadline(control({ idleUntil: "2026-01-01T00:01:00.000Z" }), now)).toBeUndefined();
	});
});

describe("formatting", () => {
	test("countdowns round up", () => {
		expect(formatCountdown(60_000)).toBe("1:00");
		expect(formatCountdown(59_001)).toBe("1:00");
		expect(formatCountdown(9_000)).toBe("0:09");
		expect(formatCountdown(1)).toBe("0:01");
		expect(formatCountdown(-5)).toBe("0:00");
		expect(formatCountdown(600_000)).toBe("10:00");
	});

	test("field labels", () => {
		expect(fieldLabel("cardNumber")).toBe("Card number");
		expect(fieldLabel("email")).toBe("Email");
		expect(fieldLabel("companyOrPageName")).toBe("Company or page name");
	});
});
