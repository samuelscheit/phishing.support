import { describe, expect, test } from "bun:test";

import { DAY_MS, HOUR_MS } from "../../util/date_time";
import { escalationPlan, pendingEscalationSteps, stepKey, type EscalationRoute } from "./policy";

const SENT = new Date("2026-11-20T10:00:00Z");
const at = (days: number, hours = 0) => new Date(SENT.getTime() + days * DAY_MS + hours * HOUR_MS);
const route = (id: number, role: EscalationRoute["role"], overrides: Partial<EscalationRoute> = {}): EscalationRoute => ({ routeId: BigInt(id), role, sentAt: SENT, escalated: false, ...overrides });
const names = (steps: ReadonlyArray<{ step: string; routeId?: bigint }>) => steps.map((step) => `${step.step}${step.routeId === undefined ? "" : `@${step.routeId}`}`);

describe("the escalation ladder", () => {
	test("a host and a registrar that do nothing: each route climbs from its own report, the site steps from the first", () => {
		const host = route(1, "host");
		const registrar = route(2, "registrar", { sentAt: at(0, 6) });
		expect(pendingEscalationSteps([host, registrar], new Set()).map((step) => `${step.step}@${step.routeId ?? "site"}+${(step.dueAt.getTime() - SENT.getTime()) / HOUR_MS}h`)).toEqual([
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
		const plan = escalationPlan([route(1, "host")], new Set(), at(1, 23));
		expect(plan.due).toEqual([]);
		expect(plan.nextAt).toEqual(at(2));
		const later = escalationPlan([route(1, "host")], new Set(), at(4, 1));
		expect(names(later.due)).toEqual(["follow_up@1", "next_contact@1"]);
		expect(later.nextAt).toEqual(at(5));
	});

	test("nothing is escalated once a month passed since the first report, however long a step was held back", () => {
		expect(names(escalationPlan([route(1, "host")], new Set(), at(30)).due)).toEqual(["follow_up@1", "next_contact@1", "upstream@1", "oversight", "exhausted"]);
		expect(escalationPlan([route(1, "host")], new Set(), at(30, 1))).toEqual({ due: [] });
	});

	test("a step taken is never due again, and the plan ends with the ladder", () => {
		const steps = pendingEscalationSteps([route(1, "host")], new Set());
		const taken = new Set(steps.map(stepKey));
		expect(escalationPlan([route(1, "host")], taken, at(29))).toEqual({ due: [] });
		expect(names(escalationPlan([route(1, "host")], new Set([stepKey({ level: 1, routeId: 1n })]), at(2)).due)).toEqual([]);
	});

	test("a provider that acted leaves the ladder; when all did, the site has no steps", () => {
		const host = route(1, "host", { decision: "action_taken" });
		expect(pendingEscalationSteps([host], new Set())).toEqual([]);
		const registrar = route(2, "registrar");
		expect(names(pendingEscalationSteps([host, registrar], new Set()))).toEqual(["follow_up@2", "next_contact@2", "oversight", "exhausted"]);
	});

	test("a provider that declined is answered by the decision follow-up, not followed up again, but the ladder goes on past it", () => {
		for (const decision of ["declined", "no_threat"] as const) {
			expect(names(pendingEscalationSteps([route(1, "host", { decision })], new Set()))).toEqual(["next_contact@1", "upstream@1", "oversight", "exhausted"]);
		}
		// Acknowledging receipt is no action.
		expect(names(pendingEscalationSteps([route(1, "cdn", { decision: "received" })], new Set()))).toEqual(["follow_up@1", "next_contact@1", "oversight", "exhausted"]);
	});

	test("a contact an escalation reached is followed up, never escalated past on its own", () => {
		const escalated = route(3, "host", { escalated: true, sentAt: at(4) });
		expect(names(pendingEscalationSteps([escalated], new Set()))).toEqual(["follow_up@3", "oversight", "exhausted"]);
	});

	test("blocklists, platforms, authorities and unsent routes are not escalated", () => {
		const routes = [route(1, "blocklist"), route(2, "platform"), route(3, "authority"), route(4, "other"), route(5, "host", { sentAt: undefined })];
		expect(pendingEscalationSteps(routes, new Set())).toEqual([]);
	});
});
