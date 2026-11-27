import type { ProviderRole } from "../../provider_stats/role";
import { DAY_MS } from "../../util/date_time";

/**
 * How a report that nobody acts on goes up, step by step, while the reported
 * site still serves what was reported. Each step is counted from when the
 * route's report reached the provider:
 *
 * 1. `follow_up` (2 days): the same provider again, on its own ticket, with
 *    proof that the site still serves the reported content.
 * 2. `next_contact` (4 days): the provider's next published abuse contact
 *    (a less specific network object, the network's AS), as a new report.
 * 3. `upstream` (5 days): a host's upstream transit provider, as a new report
 *    that names its customer.
 * 4. `oversight` (7 days, once per site): drafts to the bodies above the
 *    providers (the national CERT of the hosting country, a DSA notice to an
 *    EU host, the impersonated brand) that the operator approves, and the
 *    ICANN complaint against a gTLD registrar, which only a person can file.
 * 5. `exhausted` (14 days, once per site): nothing automatic is left; the
 *    operator decides (a criminal referral of the campaign).
 *
 * The operator can bring a step forward (`advanced`: due from then on) or
 * skip it (recorded as taken, so the ladder moves on without it).
 */
const ESCALATION_LADDER = [
	{ level: 1, step: "follow_up", afterMs: 2 * DAY_MS },
	{ level: 2, step: "next_contact", afterMs: 4 * DAY_MS },
	{ level: 3, step: "upstream", afterMs: 5 * DAY_MS },
	{ level: 4, step: "oversight", afterMs: 7 * DAY_MS },
	{ level: 5, step: "exhausted", afterMs: 14 * DAY_MS },
] as const;

export type EscalationStepName = (typeof ESCALATION_LADDER)[number]["step"];

/** Steps taken per route; the others are taken once for the site. */
const ROUTE_STEPS: ReadonlySet<EscalationStepName> = new Set(["follow_up", "next_contact", "upstream"]);

/** The roles that can take the site down; blocklists, platforms and authorities are not escalated. */
export const ESCALATED_ROLES: ReadonlySet<ProviderRole> = new Set(["host", "registrar", "cdn"]);

/** After this long since the first report, nothing is escalated any more: a step held back that long is stale. */
const ESCALATION_WINDOW_MS = 30 * DAY_MS;

/** What the ladder reads of one route of the reported site. */
export type EscalationRoute = {
	routeId: bigint;
	role: ProviderRole;
	/** When its report reached the provider; undefined while it has not, or when it bounced or was never filed. */
	sentAt?: Date;
	/** The provider's latest decision on it. */
	decision?: "action_taken" | "no_threat" | "declined" | "received";
	/** The route an escalation created: it gets the follow-up, never a further contact of its own. */
	escalated: boolean;
	/**
	 * The site left this route's hosting after the report: the host-move
	 * report told the new one, and this route takes no step of its own. It
	 * still counts for when the site's steps fall due.
	 */
	left: boolean;
};

export type EscalationStep = {
	level: number;
	step: EscalationStepName;
	routeId?: bigint;
	/** When it is due: by the ladder, or earlier when the operator brought it forward. */
	dueAt: Date;
	/** The operator brought it forward to `dueAt`. */
	advanced: boolean;
};

/** A site's routes as the ladder reads them and what was done on the ladder so far. */
export type EscalationLadder = {
	routes: readonly EscalationRoute[];
	/** The steps taken or skipped, by `stepKey`. */
	taken: ReadonlySet<string>;
	/** The steps the operator brought forward, by `stepKey`, with when. */
	advanced: ReadonlyMap<string, Date>;
};

/** A step's identity on its site's ladder: `route:<id>:<level>` or `site:<level>`. */
export const stepKey = (step: { level: number; routeId?: bigint | undefined }): string => (step.routeId === undefined ? `site:${step.level}` : `route:${step.routeId.toString()}:${step.level}`);

/** Whether the ladder applies to the route: a takedown provider it reached that has not acted. */
function climbs(route: EscalationRoute): route is EscalationRoute & { sentAt: Date } {
	return ESCALATED_ROLES.has(route.role) && route.sentAt !== undefined && route.decision !== "action_taken";
}

/** Whether the route takes this step at all. */
function routeTakes(route: EscalationRoute, step: EscalationStepName): boolean {
	if (route.left) return false;
	if (step === "follow_up") return route.decision !== "declined" && route.decision !== "no_threat";
	if (route.escalated) return false;
	return step === "next_contact" || route.role === "host";
}

/**
 * Every step of the ladder still to take at `now`, soonest first: route
 * steps counted from the route's own report, site steps from the first
 * report of a route still on the ladder, each due earlier when the operator
 * brought it forward. A site none of whose routes is on the ladder (every
 * provider acted, or none was reached) has none, and neither has one whose
 * month since the first report is over; a step the ladder would only reach
 * after that month is never taken.
 */
export function pendingEscalationSteps(ladder: EscalationLadder, now: Date): EscalationStep[] {
	const climbing = ladder.routes.filter(climbs);
	if (!climbing.length) return [];
	const first = Math.min(...climbing.map((route) => route.sentAt.getTime()));
	const closes = first + ESCALATION_WINDOW_MS;
	if (now.getTime() > closes) return [];
	const steps: EscalationStep[] = [];
	const add = (level: number, step: EscalationStepName, at: number, routeId?: bigint) => {
		const key = stepKey({ level, routeId });
		const advanced = ladder.advanced.get(key);
		if (ladder.taken.has(key) || (at > closes && !advanced)) return;
		const early = advanced !== undefined && advanced.getTime() < at;
		steps.push({ level, step, ...(routeId === undefined ? {} : { routeId }), dueAt: new Date(early ? advanced.getTime() : at), advanced: early });
	};
	for (const { level, step, afterMs } of ESCALATION_LADDER) {
		if (!ROUTE_STEPS.has(step)) add(level, step, first + afterMs);
		else for (const route of climbing) if (routeTakes(route, step)) add(level, step, route.sentAt.getTime() + afterMs, route.routeId);
	}
	return steps.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.level - b.level);
}

/** The steps due at `now`, and when the next one falls due. */
export function escalationPlan(ladder: EscalationLadder, now: Date): { due: EscalationStep[]; nextAt?: Date } {
	const pending = pendingEscalationSteps(ladder, now);
	const due = pending.filter((step) => step.dueAt.getTime() <= now.getTime());
	const later = pending.find((step) => step.dueAt.getTime() > now.getTime());
	return { due, ...(later ? { nextAt: later.dueAt } : {}) };
}
