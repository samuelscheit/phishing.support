import { describe, expect, test } from "bun:test";

import { driverStatus, EMPTY_LIVE_EVENTS, fieldLabel, formatCountdown, isLive, MAX_LIVE_ENTRIES, reconcileToken, reduceLiveEvent, turnDeadline, type LiveControl, type LiveEvents } from "./live_state";

const control = (overrides: Partial<LiveControl> = {}): LiveControl => ({ mode: "agent", tabs: [], fakeValues: {}, agentRunning: true, ...overrides });
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
		const replayed = [{ type: "browser.action", kind: "click", text: "Clicked", actor: "agent" }, { type: "browser.control", mode: "agent", tabs: [], fakeValues: {}, agentRunning: true }];
		const state = fold([{ type: "connected" }, ...replayed, { type: "connected" }, ...replayed]);
		expect(state.entries).toHaveLength(1);
		expect(state.control?.mode).toBe("agent");
	});

	test("a reconnect whose replay lacks the control state keeps the last one", () => {
		const state = fold([{ type: "browser.control", mode: "human", controller: "Viewer ab12", tabs: [], fakeValues: {}, agentRunning: true }, { type: "connected" }, { type: "browser.action", kind: "click", text: "x", actor: "human" }]);
		expect(state.control?.mode).toBe("human");
		expect(state.entries).toHaveLength(1);
		expect(isLive(state)).toBe(true);
	});

	test("the last control state is current, cleaned of anything malformed", () => {
		const state = fold([
			{ type: "browser.control", mode: "agent", tabs: [], fakeValues: {}, agentRunning: true },
			{
				type: "browser.control", mode: "human", controller: "Viewer ab12", until: "2026-01-01T00:10:00.000Z", idleUntil: "2026-01-01T00:01:00.000Z",
				tabs: [{ targetId: "t1", url: "https://a.test/", title: "", active: true }, { url: "no id" }, "junk"],
				fakeValues: { email: "x@y.test", password: 42, phone: "" },
				agentRunning: true,
			},
		]);
		expect(state.control).toEqual({
			mode: "human", controller: "Viewer ab12", until: "2026-01-01T00:10:00.000Z", idleUntil: "2026-01-01T00:01:00.000Z",
			tabs: [{ targetId: "t1", url: "https://a.test/", title: "", active: true }],
			fakeValues: { email: "x@y.test" },
			agentRunning: true,
		});
	});

	test("ignores an unknown mode, unknown types and non-objects", () => {
		const start = fold([{ type: "browser.control", mode: "agent", tabs: [], fakeValues: {}, agentRunning: true }]);
		expect(fold([{ type: "browser.control", mode: "dancing" }, { type: "response.delta" }, null, "x", [1]], start)).toBe(start);
	});

	test("a finished analysis ends the live visit whatever its last control state", () => {
		const running = fold([{ type: "browser.control", mode: "human", tabs: [], fakeValues: {}, agentRunning: true }]);
		expect(isLive(running)).toBe(true);
		expect(isLive(fold([{ type: "analysis.step", step: "visiting", progress: 40 }], running))).toBe(true);
		expect(isLive(fold([{ type: "analysis.step", step: "completed" }], running))).toBe(false);
		expect(isLive(fold([{ type: "analysis.step", step: "x", progress: 100 }], running))).toBe(false);
		expect(isLive(fold([{ type: "browser.control", mode: "ended", tabs: [], fakeValues: {}, agentRunning: false }], running))).toBe(false);
		expect(isLive(EMPTY_LIVE_EVENTS)).toBe(false);
	});
});

describe("driverStatus", () => {
	const me = { label: "Viewer ab12", driving: true };
	const watcher = { label: "Viewer ab12", driving: false };

	test("names who drives", () => {
		expect(driverStatus(control(), watcher)).toEqual({ kind: "agent" });
		expect(driverStatus(control({ agentRunning: false }), watcher)).toEqual({ kind: "finishing" });
		expect(driverStatus(control({ mode: "ended" }), watcher)).toEqual({ kind: "ended" });
		expect(driverStatus(undefined, watcher)).toEqual({ kind: "ended" });
		expect(driverStatus(control({ mode: "human", controller: "Viewer ab12" }), me)).toEqual({ kind: "you" });
		expect(driverStatus(control({ mode: "human", controller: "Viewer cd34" }), watcher)).toEqual({ kind: "other", label: "Viewer cd34" });
		expect(driverStatus(control({ mode: "pausing", controller: "Viewer ab12" }), me)).toEqual({ kind: "pausing", mine: true, label: "Viewer ab12" });
		expect(driverStatus(control({ mode: "pausing", controller: "Viewer cd34" }), watcher)).toEqual({ kind: "pausing", mine: false, label: "Viewer cd34" });
	});

	test("a stale token of this viewer does not make another driver's turn its own", () => {
		expect(driverStatus(control({ mode: "human", controller: "Viewer cd34" }), me)).toEqual({ kind: "other", label: "Viewer cd34" });
	});

	test("without its own label (no Web Crypto), a viewer's token decides", () => {
		expect(driverStatus(control({ mode: "human", controller: "Viewer cd34" }), { driving: true })).toEqual({ kind: "you" });
	});
});

describe("reconcileToken", () => {
	const label = "Viewer ab12";
	const held = { token: "t", confirmed: false };

	test("keeps a fresh token while the stream still shows the agent (the take's answer came first)", () => {
		expect(reconcileToken(held, control(), label)).toBe(held);
	});

	test("confirms once the stream names this viewer, and keeps it", () => {
		const confirmed = reconcileToken(held, control({ mode: "pausing", controller: label }), label);
		expect(confirmed).toEqual({ token: "t", confirmed: true });
		expect(reconcileToken(confirmed, control({ mode: "human", controller: label }), label)).toBe(confirmed);
	});

	test("drops a confirmed token once the turn ended or went to someone else", () => {
		const confirmed = { token: "t", confirmed: true };
		expect(reconcileToken(confirmed, control(), label)).toEqual({ confirmed: false });
		expect(reconcileToken(confirmed, control({ mode: "human", controller: "Viewer cd34" }), label)).toEqual({ confirmed: false });
	});

	test("drops any token when the visit ended", () => {
		expect(reconcileToken(held, control({ mode: "ended" }), label)).toEqual({ confirmed: false });
		expect(reconcileToken(held, undefined, label)).toEqual({ confirmed: false });
		expect(reconcileToken({ confirmed: true }, control(), label)).toEqual({ confirmed: false });
	});

	test("without a label any named driver confirms", () => {
		expect(reconcileToken(held, control({ mode: "human", controller: "Viewer cd34" }), undefined)).toEqual({ token: "t", confirmed: true });
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
