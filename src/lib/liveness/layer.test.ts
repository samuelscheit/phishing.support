import { describe, expect, test } from "bun:test";

import { isDown, isUp, siteCheckLayer, takedownOf } from "./layer";
import { siteCheckStates, type SiteCheck, type SiteCheckState } from "./schema";

const HOUR = 60 * 60_000;
const reportedAt = new Date("2026-11-01T12:00:00.000Z");

function at(hours: number): Date {
	return new Date(reportedAt.getTime() + hours * HOUR);
}

/** One target's checks, each `[hours after the report, state]`. */
function checks(...entries: Array<[number, SiteCheckState]>): SiteCheck[] {
	return entries.map(([hours, state], index) => ({
		id: BigInt(index + 1),
		reportId: 1n,
		targetId: 7n,
		url: "https://kit.example/login",
		state,
		httpStatus: null,
		finalUrl: null,
		resolvedAddresses: [],
		hosting: null,
		domainStatuses: [],
		detail: null,
		checkedAt: at(hours),
	}));
}

describe("layers", () => {
	test("every state names the layer that acted, or none while the site is up", () => {
		const layers = Object.fromEntries(siteCheckStates.map((state) => [state, siteCheckLayer(state)]));
		expect(layers).toEqual({
			online: undefined,
			redirected: undefined,
			unreachable: "host",
			removed: "host",
			host_suspended: "host",
			cdn_blocked: "cdn",
			parked: "registrar",
			domain_suspended: "registrar",
			domain_gone: "registrar",
		});
		for (const state of siteCheckStates) expect(isDown(state)).toBe(layers[state] !== undefined);
		for (const state of siteCheckStates) expect(isUp(state)).toBe(!isDown(state));
	});
});

describe("takedownOf", () => {
	test("no checks: nothing is known beyond the report", () => {
		expect(takedownOf([], reportedAt)).toEqual({ lastOnlineAt: reportedAt, stillOnline: false, exactTime: false });
	});

	test("a site online at every check", () => {
		expect(takedownOf(checks([1, "online"], [6, "online"], [24, "redirected"]), reportedAt))
			.toEqual({ lastOnlineAt: at(24), state: "redirected", stillOnline: true, exactTime: false });
	});

	test("a takedown between two checks is dated exactly", () => {
		expect(takedownOf(checks([1, "online"], [6, "online"], [24, "removed"], [72, "removed"]), reportedAt))
			.toEqual({ downAt: at(24), lastOnlineAt: at(6), layer: "host", state: "removed", stillOnline: false, exactTime: true });
	});

	test("a first check soon after the report dates a takedown it finds", () => {
		expect(takedownOf(checks([1, "cdn_blocked"]), reportedAt))
			.toEqual({ downAt: at(1), lastOnlineAt: reportedAt, layer: "cdn", state: "cdn_blocked", stillOnline: false, exactTime: true });
		expect(takedownOf(checks([2, "cdn_blocked"]), reportedAt).exactTime).toBe(true);
	});

	test("a first check long after the report gives only an upper bound", () => {
		// A backfilled target: its one check came 40 days after the report.
		expect(takedownOf(checks([40 * 24, "domain_gone"]), reportedAt))
			.toEqual({ downAt: at(40 * 24), lastOnlineAt: reportedAt, layer: "registrar", state: "domain_gone", stillOnline: false, exactTime: false });
		expect(takedownOf(checks([2.5, "parked"]), reportedAt).exactTime).toBe(false);
	});

	test("one unreachable check is a hiccup, not a takedown", () => {
		expect(takedownOf(checks([1, "online"], [6, "unreachable"], [24, "online"]), reportedAt))
			.toEqual({ lastOnlineAt: at(24), state: "online", stillOnline: true, exactTime: false });
		// The latest check unreachable: unconfirmed until the next one.
		expect(takedownOf(checks([1, "online"], [6, "unreachable"]), reportedAt))
			.toEqual({ lastOnlineAt: at(1), state: "unreachable", stillOnline: false, exactTime: false });
		expect(takedownOf(checks([1, "unreachable"]), reportedAt).downAt).toBeUndefined();
	});

	test("unreachable twice in a row is a takedown from the first", () => {
		expect(takedownOf(checks([1, "online"], [6, "unreachable"], [24, "unreachable"]), reportedAt))
			.toEqual({ downAt: at(6), lastOnlineAt: at(1), layer: "host", state: "unreachable", stillOnline: false, exactTime: true });
	});

	test("an unreachable takedown takes its layer from the state that follows it", () => {
		expect(takedownOf(checks([1, "online"], [6, "unreachable"], [24, "domain_gone"]), reportedAt))
			.toMatchObject({ downAt: at(6), layer: "registrar", state: "domain_gone" });
		expect(takedownOf(checks([1, "online"], [6, "unreachable"], [24, "unreachable"], [72, "parked"]), reportedAt))
			.toMatchObject({ downAt: at(6), layer: "registrar", state: "parked" });
		expect(takedownOf(checks([1, "online"], [6, "unreachable"], [24, "cdn_blocked"]), reportedAt).layer).toBe("cdn");
	});

	test("an unconfirmed unreachable before a confirmed one does not date the takedown", () => {
		expect(takedownOf(checks([1, "unreachable"], [6, "online"], [24, "unreachable"], [72, "removed"]), reportedAt))
			.toEqual({ downAt: at(24), lastOnlineAt: at(6), layer: "host", state: "removed", stillOnline: false, exactTime: true });
	});

	test("a site that came back keeps its first takedown and reports its latest state", () => {
		expect(takedownOf(checks([1, "online"], [6, "removed"], [24, "online"], [72, "host_suspended"], [168, "online"]), reportedAt))
			.toEqual({ downAt: at(6), lastOnlineAt: at(1), layer: "host", state: "online", stillOnline: true, exactTime: true });
	});

	test("checks before the report are about something else and are ignored", () => {
		const earlier = checks([-48, "domain_gone"], [-1, "removed"], [1, "online"], [6, "online"]);
		expect(takedownOf(earlier, reportedAt)).toEqual({ lastOnlineAt: at(6), state: "online", stillOnline: true, exactTime: false });
		expect(takedownOf(checks([-2, "online"], [30, "removed"]), reportedAt))
			.toEqual({ downAt: at(30), lastOnlineAt: reportedAt, layer: "host", state: "removed", stillOnline: false, exactTime: false });
	});

	test("a redirect is the site up", () => {
		expect(takedownOf(checks([1, "redirected"], [6, "parked"]), reportedAt))
			.toMatchObject({ downAt: at(6), lastOnlineAt: at(1), layer: "registrar", exactTime: true });
	});
});
