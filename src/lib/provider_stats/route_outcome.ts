import type { AbuseMailClassification, AbuseRouteStatus, AbuseRouteType } from "../abuse/schema";

/**
 * How a provider answered one report, as far as the record shows:
 *
 * - `acknowledged`: it confirmed receipt, is investigating, or said it acted
 *   (the reply classifier's meaning). Whether it acted is the takedown record's.
 * - `rejected`: it declined to act.
 * - `not_monitored`: its abuse mailbox answered that nobody reads it.
 * - `needs_more_information`: it asked for more before deciding.
 * - `no_decision`: it answered, but neither acknowledged nor declined.
 * - `no_reply`: the report was delivered and nothing came back.
 * - `bounced`: the report never reached anyone.
 * - `not_delivered`: it was never filed: our side failed, or the provider's
 *   form refused the submission itself (a duplicate, a failed captcha, a
 *   missing field) before anyone looked at the abuse. The provider is not
 *   measured on it.
 * - `pending`: delivery is still in progress.
 */
export const routeVerdicts = ["acknowledged", "rejected", "not_monitored", "needs_more_information", "no_decision", "no_reply", "bounced", "not_delivered", "pending"] as const;
export type RouteVerdict = (typeof routeVerdicts)[number];

/** Verdicts that are the provider's own answer, and so count for or against it. */
export const PROVIDER_VERDICTS: readonly RouteVerdict[] = ["acknowledged", "rejected", "not_monitored", "needs_more_information", "no_decision", "no_reply", "bounced"];

export type RouteMessageFact = {
	direction: "outbound" | "inbound";
	kind: string;
	status: string;
	classification: AbuseMailClassification | null;
	correlationKey: string | null;
	occurredAt: Date;
};

export type RouteFacts = {
	routeType: AbuseRouteType;
	status: AbuseRouteStatus;
	createdAt: Date;
	/** Every `route.status_changed` event of the route. */
	statusChanges: ReadonlyArray<{ to: string; at: Date }>;
	messages: readonly RouteMessageFact[];
	/** Decisions the follow-up agent looked at and chose not to answer. */
	unansweredDecisions: number;
};

export type RouteOutcome = {
	verdict: RouteVerdict;
	/** When the report reached the provider; undefined when it never did. */
	sentAt?: Date;
	/** The provider's first answer of any kind, automatic receipts included. */
	firstReplyAt?: Date;
	/** When the provider first acknowledged, declined, or asked for more. */
	decisionAt?: Date;
	/** Messages we sent after the report itself: answers to decisions and other follow-ups. */
	followUps: number;
	unansweredDecisions: number;
	/** A refusal or request for more turned into acceptance after a follow-up. */
	overturnedByFollowUp: boolean;
	inbound: number;
	outbound: number;
};

/** Where each route status leaves a route that shows no sign of having reached the provider. Exhaustive, so a new status must be placed. */
const UNDELIVERED_AS: Record<AbuseRouteStatus, "not_delivered" | "pending" | "delivered"> = {
	failed: "not_delivered",
	unknown_external_state: "not_delivered",
	insufficient_evidence: "not_delivered",
	needs_human: "not_delivered",
	no_route: "not_delivered",
	discarded: "not_delivered",
	// Our relay refused the mail, or preparing it failed: never sent.
	delivery_failed: "not_delivered",
	// The provider's form refused the submission before filing it (a duplicate, a failed captcha, a missing field).
	provider_rejected: "not_delivered",
	awaiting_approval: "pending",
	resolving: "pending",
	verified: "pending",
	queued: "pending",
	running: "pending",
	escalating_to_portal: "pending",
	submitted: "delivered",
	awaiting_provider_reply: "delivered",
	acknowledged: "delivered",
};
const DECISIVE: ReadonlySet<AbuseMailClassification> = new Set(["acknowledged", "rejected", "not_monitored", "needs_more_information"]);
const CONTESTED: ReadonlySet<RouteVerdict> = new Set(["rejected", "needs_more_information", "not_monitored"]);
/** An acknowledgement this soon after a follow-up is the provider's automatic receipt of it, not a change of mind. */
const RECEIPT_WINDOW_MS = 15 * 60_000;
/** A provider's review state as our poll records it; it is an answer only when its state is a verdict. */
const STATUS_RECORD = /^provider-api:[^:]+:status:/;

function earliest(...dates: Array<Date | undefined>): Date | undefined {
	const known = dates.filter((date): date is Date => date !== undefined);
	return known.length ? new Date(Math.min(...known.map((date) => date.getTime()))) : undefined;
}

/** Ingestion stores every delivery report as a bounce (abuse/mail/delivery_report.ts). */
const isBounce = (message: RouteMessageFact) => message.kind === "bounce";

/**
 * Derive one route's outcome from its status, its status history and its
 * correspondence. Delivery is read from what happened (the report sent, the
 * route filed, an answer received), not from the route's current status,
 * which a later escalation or retry may have changed. The latest decisive
 * answer wins, so a refusal that a follow-up turned around counts as
 * acknowledged (and as overturned); the automatic receipt of a follow-up
 * does not turn anything around.
 */
export function routeOutcomeOf(facts: RouteFacts): RouteOutcome {
	const messages = [...facts.messages].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
	const sentOutbound = messages.filter((message) => message.direction === "outbound" && message.status === "sent");
	const inbound = messages
		.filter((message) => message.direction === "inbound")
		// A poll that found no verdict recorded our reading, not a provider answer;
		// a refusal by our own relay means the provider never saw the report.
		.filter((message) => !(message.correlationKey && STATUS_RECORD.test(message.correlationKey) && !message.classification))
		.filter((message) => message.classification !== "relay_refused");
	const bounces = inbound.filter(isBounce);
	const replies = inbound.filter((message) => !isBounce(message));
	const changedTo = (statuses: readonly string[]) => facts.statusChanges.filter((change) => statuses.includes(change.to)).map((change) => change.at).sort((a, b) => a.getTime() - b.getTime())[0];

	// A mail route's first sent report is the report itself; a direct submission's report is its API call.
	const report = facts.routeType === "email" ? sentOutbound.find((message) => message.kind === "report" && !message.correlationKey?.startsWith("decision-follow-up:")) : undefined;
	const followUps = sentOutbound.filter((message) => message !== report);
	const followUpTimes = followUps.map((message) => message.occurredAt.getTime());
	const base = {
		followUps: followUps.length,
		unansweredDecisions: facts.unansweredDecisions,
		inbound: inbound.length,
		outbound: sentOutbound.length,
	};

	// A mail route reached the provider when a report went out and stayed out: a refused or
	// failed send leaves no `sent` report. Only a route with no outbound record at all
	// is taken at its status history's word.
	const hasOutbound = messages.some((message) => message.direction === "outbound");
	const filedAt = facts.routeType === "email" && hasOutbound ? undefined : changedTo(["submitted", "awaiting_provider_reply"]);
	const deliveredAt = earliest(report?.occurredAt, filedAt, replies[0]?.occurredAt, bounces[0]?.occurredAt);
	const undelivered = UNDELIVERED_AS[facts.status];
	if (!deliveredAt && (facts.statusChanges.length || undelivered !== "delivered")) {
		return { ...base, verdict: undelivered === "delivered" ? "pending" : undelivered, overturnedByFollowUp: false };
	}
	const sentAt = deliveredAt ?? facts.createdAt;

	// Contested answers stand until a real acknowledgement: one outside the receipt window of a follow-up.
	const decisive = replies.filter((message) => message.classification && DECISIVE.has(message.classification)).filter((message, index, all) => {
		if (message.classification !== "acknowledged") return true;
		const previous = all.slice(0, index).at(-1)?.classification as RouteVerdict | undefined;
		if (!previous || !CONTESTED.has(previous)) return true;
		const at = message.occurredAt.getTime();
		return !followUpTimes.some((time) => at >= time && at - time <= RECEIPT_WINDOW_MS);
	});
	const latestDecision = decisive.at(-1)?.classification as RouteVerdict | undefined;

	let verdict: RouteVerdict;
	if (latestDecision) verdict = latestDecision;
	else if (bounces.length && !replies.length) verdict = "bounced";
	else if (facts.status === "provider_rejected") verdict = "rejected";
	else if (facts.status === "acknowledged") verdict = "acknowledged";
	else if (replies.length) verdict = "no_decision";
	else verdict = "no_reply";

	// The decision is when the final verdict first stood: after the last answer that said otherwise.
	const lastOther = decisive.findLastIndex((message) => message.classification !== verdict);
	const decisionAt = decisive[lastOther + 1]?.occurredAt
		?? (verdict === "rejected" || verdict === "acknowledged" ? changedTo(verdict === "rejected" ? ["provider_rejected"] : ["acknowledged"]) : undefined);
	const firstFollowUp = followUpTimes[0];
	const before = firstFollowUp === undefined ? undefined : decisive.filter((message) => message.occurredAt.getTime() < firstFollowUp).at(-1)?.classification as RouteVerdict | undefined;
	const overturnedByFollowUp = Boolean(before && CONTESTED.has(before) && verdict === "acknowledged");

	return {
		...base,
		verdict,
		sentAt,
		...(replies[0] ? { firstReplyAt: replies[0].occurredAt } : {}),
		...(decisionAt ? { decisionAt } : {}),
		overturnedByFollowUp,
	};
}
