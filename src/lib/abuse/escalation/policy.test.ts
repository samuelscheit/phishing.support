import { describe, expect, test } from "bun:test";

import { DAY_MS, HOUR_MS } from "../../util/date_time";
import { escalationPlan, pendingEscalationSteps, stepKey, type EscalationLadder, type EscalationRoute } from "./policy";

const SENT = new Date("2026-11-20T10:00:00Z");
const at = (days: number, hours = 0) => new Date(SENT.getTime() + days * DAY_MS + hours * HOUR_MS);
const route = (id: number, role: EscalationRoute["role"], overrides: Partial<EscalationRoute> = {}): EscalationRoute => ({ routeId: BigInt(id), role, sentAt: SENT, escalated: false, left: false, ...overrides });
const ladder = (routes: EscalationRoute[], records: { taken?: string[]; advanced?: Array<[string, Date]> } = {}): EscalationLadder => ({ routes, taken: new Set(records.taken ?? []), advanced: new Map(records.advanced ?? []) });
const names = (steps: ReadonlyArray<{ step: string; routeId?: bigint }>) => steps.map((step) => `${step.step}${step.routeId === undefined ? "" : `@${step.routeId}`}`);
const pending = (routes: EscalationRoute[], now = at(1)) => names(pendingEscalationSteps(ladder(routes), now));

describe("the escalation ladder", () => {
	test("a host and a registrar that do nothing: each route climbs from its own report, the site steps from the first", () => {
		const host = route(1, "host");
		const registrar = route(2, "registrar", { sentAt: at(0, 6) });
		expect(pendingEscalationSteps(ladder([host, registrar]), at(1)).map((step) => `${step.step}@${step.routeId ?? "site"}+${(step.dueAt.getTime() - SENT.getTime()) / HOUR_MS}h`)).toEqual([
			"follow_up@1+48h",
			"follow_up@2+54h",
			"next_contact@1+96h",
			"next_contact@2+102h",
			// Only a host has an upstream transit provider.
			"upstream@1+120h",
			"oversight@site+168h",
			"exhausted@site+336h",
		]);
	});

	test("nothing is due before its time; the plan names when the next step falls due", () => {
		const plan = escalationPlan(ladder([route(1, "host")]), at(1, 23));
		expect(plan.due).toEqual([]);
		expect(plan.nextAt).toEqual(at(2));
		const later = escalationPlan(ladder([route(1, "host")]), at(4, 1));
		expect(names(later.due)).toEqual(["follow_up@1", "next_contact@1"]);
		expect(later.nextAt).toEqual(at(5));
	});

	test("nothing is escalated once a month passed since the first report, however long a step was held back", () => {
		expect(names(escalationPlan(ladder([route(1, "host")]), at(30)).due)).toEqual(["follow_up@1", "next_contact@1", "upstream@1", "oversight", "exhausted"]);
		expect(escalationPlan(ladder([route(1, "host")]), at(30, 1))).toEqual({ due: [] });
		expect(pendingEscalationSteps(ladder([route(1, "host")]), at(30, 1))).toEqual([]);
	});

	test("a step the ladder would only reach after the month is never planned; the site's month counts from its first report", () => {
		// A contact an escalation reached on day 29 would be followed up on day 31.
		const late = route(2, "host", { escalated: true, sentAt: at(29) });
		const steps = pendingEscalationSteps(ladder([route(1, "host"), late], { taken: ["route:1:1", "route:1:2", "route:1:3", "site:4", "site:5"] }), at(29, 1));
		expect(steps).toEqual([]);
		expect(escalationPlan(ladder([route(1, "host"), late], { taken: ["route:1:1", "route:1:2", "route:1:3", "site:4", "site:5"] }), at(29, 1))).toEqual({ due: [] });
	});

	test("a step taken or skipped is never due again, and the plan ends with the ladder", () => {
		const steps = pendingEscalationSteps(ladder([route(1, "host")]), at(1));
		expect(escalationPlan(ladder([route(1, "host")], { taken: steps.map(stepKey) }), at(29))).toEqual({ due: [] });
		expect(names(escalationPlan(ladder([route(1, "host")], { taken: [stepKey({ level: 1, routeId: 1n })] }), at(2)).due)).toEqual([]);
		// Skipping the follow-up moves the ladder on: the next contact comes on its own time.
		expect(names(pendingEscalationSteps(ladder([route(1, "host")], { taken: ["route:1:1"] }), at(1)))[0]).toBe("next_contact@1");
	});

	test("a step the operator brought forward is due from then on, the others keep their time", () => {
		const plan = escalationPlan(ladder([route(1, "host"), route(2, "registrar")], { advanced: [["route:1:2", at(1)]] }), at(1));
		expect(names(plan.due)).toEqual(["next_contact@1"]);
		expect(plan.due[0]).toMatchObject({ dueAt: at(1), advanced: true });
		expect(plan.nextAt).toEqual(at(2));
		// Brought forward to a time after it fell due anyway changes nothing.
		const late = pendingEscalationSteps(ladder([route(1, "host")], { advanced: [["route:1:1", at(3)]] }), at(3));
		expect(late[0]).toMatchObject({ step: "follow_up", dueAt: at(2), advanced: false });
		// A taken step stays taken, brought forward or not; one brought forward is still the operator's even past the month.
		expect(names(pendingEscalationSteps(ladder([route(1, "host")], { taken: ["route:1:1"], advanced: [["route:1:1", at(1)]] }), at(1)))).not.toContain("follow_up@1");
		expect(names(pendingEscalationSteps(ladder([route(1, "host"), route(2, "host", { escalated: true, sentAt: at(29) })], { advanced: [["route:2:1", at(29, 1)]] }), at(29, 1)))).toContain("follow_up@2");
	});

	test("a provider that acted leaves the ladder; when all did, the site has no steps", () => {
		const host = route(1, "host", { decision: "action_taken" });
		expect(pending([host])).toEqual([]);
		expect(pending([host, route(2, "registrar")])).toEqual(["follow_up@2", "next_contact@2", "oversight", "exhausted"]);
	});

	test("a provider that declined is answered by the decision follow-up, not followed up again, but the ladder goes on past it", () => {
		for (const decision of ["declined", "no_threat"] as const) {
			expect(pending([route(1, "host", { decision })])).toEqual(["next_contact@1", "upstream@1", "oversight", "exhausted"]);
		}
		// Acknowledging receipt is no action.
		expect(pending([route(1, "cdn", { decision: "received" })])).toEqual(["follow_up@1", "next_contact@1", "oversight", "exhausted"]);
	});

	test("a contact an escalation reached is followed up, never escalated past on its own", () => {
		expect(pending([route(3, "host", { escalated: true, sentAt: at(4) })], at(5))).toEqual(["follow_up@3", "oversight", "exhausted"]);
	});

	test("the hosting a site left takes no step of its own, but still dates the site's steps; its registrar climbs on", () => {
		const left = route(1, "host", { left: true });
		const registrar = route(2, "registrar", { sentAt: at(1) });
		const steps = pendingEscalationSteps(ladder([left, registrar]), at(1));
		expect(names(steps)).toEqual(["follow_up@2", "next_contact@2", "oversight", "exhausted"]);
		expect(steps.find((step) => step.step === "oversight")!.dueAt).toEqual(at(7));
		expect(pending([left])).toEqual(["oversight", "exhausted"]);
	});

	test("blocklists, platforms, authorities and unsent routes are not escalated", () => {
		expect(pending([route(1, "blocklist"), route(2, "platform"), route(3, "authority"), route(4, "other"), route(5, "host", { sentAt: undefined })])).toEqual([]);
	});
});

describe("a hold on the ladder", () => {
	test("every step waits for it; it dates when they are taken, not when they are due", () => {
		const plan = escalationPlan({ ...ladder([route(1, "host")]), heldUntil: at(3) }, at(2, 1));
		expect(plan).toEqual({ due: [], nextAt: at(3) });
		const [followUp] = pendingEscalationSteps({ ...ladder([route(1, "host")]), heldUntil: at(3) }, at(2, 1));
		expect(followUp).toMatchObject({ step: "follow_up", dueAt: at(2), at: at(3), heldUntil: at(3) });
		// A step due after the hold ends is not held.
		expect(pendingEscalationSteps({ ...ladder([route(1, "host")]), heldUntil: at(3) }, at(2, 1)).find((step) => step.step === "next_contact")).toMatchObject({ at: at(4), dueAt: at(4) });
		expect(pendingEscalationSteps({ ...ladder([route(1, "host")]), heldUntil: at(3) }, at(2, 1)).find((step) => step.step === "next_contact")!.heldUntil).toBeUndefined();
	});

	test("a step the hold would push past the month is never planned", () => {
		const held = { ...ladder([route(1, "host")], { taken: ["route:1:1", "route:1:2", "route:1:3", "site:4"] }), heldUntil: at(31) };
		expect(pendingEscalationSteps(held, at(25))).toEqual([]);
		expect(escalationPlan(held, at(25))).toEqual({ due: [] });
		// Ending right as the month closes, it still is.
		expect(names(pendingEscalationSteps({ ...held, heldUntil: at(30) }, at(25)))).toEqual(["exhausted"]);
	});
});
