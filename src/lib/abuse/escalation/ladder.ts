import { hostMovesOf } from "../../liveness/moves";
import type { SubmissionReportRoute } from "../../submissions/abuse_details";
import { decisionOf } from "../../submissions/report_view";
import { DAY_MS } from "../../util/date_time";
import { asRecord } from "../../util/values";
import { routeContact } from "../resolver/contact_chain";
import type { AbuseEvent, AbuseProviderRoute } from "../schema";
import { pendingEscalationSteps, stepKey, type EscalationLadder, type EscalationRoute, type EscalationStep } from "./policy";

/** The one job per target that takes its ladder's steps. */
export const escalationJobKey = (targetId: bigint) => `escalation:${targetId.toString()}`;

/** One step of the ladder taken for a route or the site, with what it did; the operator's skip is one too (`skipped`). */
export const ESCALATION_EVENT = "route.escalated";
/** The ladder waited: the site no longer serves the reported content, or that could not be confirmed. */
export const ESCALATION_HELD_EVENT = "escalation.held";
/** The operator brought a step forward: it is due from then on, and a hold before it is lifted. */
export const ESCALATION_ADVANCED_EVENT = "escalation.advanced";
/** A site whose content could not be confirmed is looked at again this much later. */
const UNVERIFIED_RETRY_MS = DAY_MS;
/** A site whose page changed into something the classifier finds harmless is looked at again this much later. */
const NOT_MALICIOUS_RETRY_MS = 7 * DAY_MS;
/** Answers that say the report never reached anyone: such a route has nothing to escalate from. */
const UNDELIVERED = new Set(["bounced", "not_delivered", "pending"]);

type LadderEvent = Pick<AbuseEvent, "eventType" | "targetId" | "routeId" | "data" | "createdAt">;
type LadderRouteRecord = Pick<AbuseProviderRoute, "id" | "targetId" | "resolverProvenance">;
type LadderView = Pick<SubmissionReportRoute, "id" | "role" | "outcome" | "messages">;

/** One route of the target with its case-page view and what the ladder reads of it. */
export type LadderRouteState<R extends LadderRouteRecord = LadderRouteRecord, V extends LadderView = SubmissionReportRoute> = { route: R; view: V; ladder: EscalationRoute };

/** A target's escalation ladder as its records stand: its routes, the steps taken, skipped and brought forward, and a hold. */
export type TargetLadder<R extends LadderRouteRecord = LadderRouteRecord, V extends LadderView = SubmissionReportRoute> = {
	states: LadderRouteState<R, V>[];
	ladder: EscalationLadder;
	/** Until when a check that found the site not (confirmably) serving holds the ladder. */
	heldUntil?: Date;
};

/** A step still to take, with when the ladder takes it: when it is due, or when a hold ends. */
export type ScheduledStep = EscalationStep & { key: string; at: Date; heldUntil?: Date };

/** The skip the operator recorded, as a step taken. */
export const isSkipped = (event: Pick<AbuseEvent, "data">): boolean => asRecord(event.data)?.skipped === true;

/** The step key an escalation event (taken, skipped, brought forward) is about. */
function eventStepKey(event: LadderEvent): string | undefined {
	const level = Number(asRecord(event.data)?.level);
	return Number.isInteger(level) ? stepKey({ level, ...(event.routeId === null ? {} : { routeId: event.routeId }) }) : undefined;
}

/**
 * When the ladder may look at the site again after it held: a day after
 * content that could not be confirmed, a week after a page the classifier
 * found harmless. The operator bringing a step forward after the hold lifts
 * it. A site taken down is not checked by liveness for escalation at all
 * until it is back up.
 */
function heldUntil(events: readonly LadderEvent[], targetId: bigint): Date | undefined {
	const ofTarget = events.filter((event) => event.targetId === targetId);
	const heldAt = ofTarget.findLastIndex((event) => event.eventType === ESCALATION_HELD_EVENT);
	if (heldAt < 0 || ofTarget.findLastIndex((event) => event.eventType === ESCALATION_ADVANCED_EVENT) > heldAt) return undefined;
	const data = asRecord(ofTarget[heldAt]!.data);
	const at = typeof data?.at === "string" ? new Date(data.at) : ofTarget[heldAt]!.createdAt;
	return new Date(at.getTime() + (data?.verdict === "not_malicious" ? NOT_MALICIOUS_RETRY_MS : UNVERIFIED_RETRY_MS));
}

/**
 * The target's ladder from its records: each route the case page shows
 * (`views`) as the ladder reads it, the steps taken (the operator's skips
 * among them) and brought forward, and a hold. A site that left the hosting
 * it was reported on is not escalated to that hosting any more: the
 * host-move report tells the new host; its registrar still climbs.
 */
export function targetLadder<R extends LadderRouteRecord, V extends LadderView>(targetId: bigint, routes: readonly R[], views: readonly V[], events: readonly LadderEvent[]): TargetLadder<R, V> {
	const viewsById = new Map(views.map((view) => [view.id, view]));
	const moved = hostMovesOf(events).some((move) => move.targetId === targetId.toString());
	const states = routes.filter((route) => route.targetId === targetId && viewsById.has(route.id)).map((route) => {
		const view = viewsById.get(route.id)!;
		const decision = decisionOf(view.messages)?.decision.outcome;
		return {
			route,
			view,
			ladder: {
				routeId: route.id,
				role: view.role,
				...(view.outcome.sentAt && !UNDELIVERED.has(view.outcome.verdict) ? { sentAt: new Date(view.outcome.sentAt) } : {}),
				...(decision ? { decision } : {}),
				escalated: asRecord(routeContact(route.resolverProvenance).escalation) !== undefined,
				left: moved && view.role !== "registrar",
			},
		};
	});
	const ofTarget = events.filter((event) => event.targetId === targetId);
	const keyed = (type: string) => ofTarget.filter((event) => event.eventType === type).flatMap((event) => {
		const key = eventStepKey(event);
		return key === undefined ? [] : [{ key, event }];
	});
	const advanced = new Map(keyed(ESCALATION_ADVANCED_EVENT).map(({ key, event }) => {
		const at = asRecord(event.data)?.at;
		return [key, typeof at === "string" ? new Date(at) : event.createdAt] as const;
	}));
	const held = heldUntil(events, targetId);
	return {
		states,
		ladder: { routes: states.map((state) => state.ladder), taken: new Set(keyed(ESCALATION_EVENT).map(({ key }) => key)), advanced },
		...(held ? { heldUntil: held } : {}),
	};
}

/** The steps still to take at `now`, soonest first, each with when the ladder takes it. */
export function scheduledSteps(target: Pick<TargetLadder, "ladder" | "heldUntil">, now: Date): ScheduledStep[] {
	return pendingEscalationSteps(target.ladder, now).map((step) => {
		const held = target.heldUntil && target.heldUntil > step.dueAt ? target.heldUntil : undefined;
		return { ...step, key: stepKey(step), at: held ?? step.dueAt, ...(held ? { heldUntil: held } : {}) };
	}).sort((a, b) => a.at.getTime() - b.at.getTime() || a.level - b.level);
}

/** When the first of the target's reports reached a provider: what the escalation texts date the report by. */
export function firstSentAt(states: readonly Pick<LadderRouteState, "ladder">[]): Date | undefined {
	const sent = states.flatMap((state) => (state.ladder.sentAt ? [state.ladder.sentAt.getTime()] : []));
	return sent.length ? new Date(Math.min(...sent)) : undefined;
}

/** Which of a route's further contacts a step reports to: the upstream transit provider, or the provider's next published contact. */
export const contactForStep = (step: "next_contact" | "upstream") => (contact: Readonly<Record<string, unknown>>): boolean => Boolean(contact.transit) === (step === "upstream");
