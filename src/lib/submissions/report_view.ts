import type { CleanMailText } from "@/lib/abuse/mail/clean_text";
import type { ProviderDecision } from "@/lib/abuse/providers/submission_contracts";
import type { AbuseMailClassification } from "@/lib/abuse/schema";
import { leadSentence } from "@/lib/abuse/mail/clean_text";
import type { ReportSubject, SubmissionReport, SubmissionReportMessage, SubmissionReportRoute } from "./abuse_details";

/**
 * Where a report to one provider stands, from the reporter's side, strongest first:
 *
 * - `action_taken`: the provider acted on the site (restricted it, blocklisted it).
 * - `received`: it confirmed the report and has not decided yet.
 * - `declined`: its check found no threat, or it closed the report without acting.
 * - `unconfirmed`: our submission's answer was lost; whether the provider has the report is not known yet.
 * - `waiting`: sent and not answered yet, or still being sent.
 * - `not_sent`: it never reached the provider: refused, bounced, or stopped before sending.
 */
export const routeBuckets = ["action_taken", "received", "declined", "unconfirmed", "waiting", "not_sent"] as const;
export type RouteBucket = (typeof routeBuckets)[number];

/** One step of Sent → Received → Decision. */
export type StepState = "done" | "negative" | "waiting" | "unknown" | "todo";

export type RouteStanding = {
	bucket: RouteBucket;
	/** Plain words: "Access restricted", "Not confirmed yet", "Awaiting reply". */
	label: string;
	/** The provider's own key sentence, or what we know in its place. */
	line?: string;
	/** Whether `line` is the provider's own words. */
	quoted: boolean;
	/** When the standing was reached: the decision, the answer, or the sending. */
	at?: Date;
	steps: { sent: StepState; received: StepState; decision: StepState };
};

type Decided = { decision: ProviderDecision; at: Date };

const GENERIC: Partial<Record<AbuseMailClassification, ProviderDecision>> = {
	acknowledged: { outcome: "received", label: "Received" },
	rejected: { outcome: "declined", label: "Declined" },
	needs_more_information: { outcome: "received", label: "Asked for more information" },
	not_monitored: { outcome: "declined", label: "Mailbox not monitored" },
};

/** Whether a classified answer says what a decision already read says: an acknowledgement after an action, a rejection after "no threat". */
function agrees(decision: ProviderDecision, classification: AbuseMailClassification): boolean {
	if (classification === "acknowledged") return decision.outcome === "action_taken" || decision.outcome === "received";
	if (classification === "rejected") return decision.outcome === "declined" || decision.outcome === "no_threat";
	return false;
}

const bySent = (a: { occurredAt: Date | string }, b: { occurredAt: Date | string }) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();

/**
 * The provider's decision as its answers state it, latest first: a decision
 * a provider's own rules read from a message or review state; otherwise a
 * classified answer; and a review state that decides nothing ("material
 * auditing") as a report under review. A later answer that agrees with the
 * decision in effect (Cloudflare's `accepted` after restricting access) keeps
 * that decision, with its sentence.
 */
export function decisionOf(messages: readonly SubmissionReportMessage[]): Decided | undefined {
	let current: Decided | undefined;
	for (const message of [...messages].sort(bySent)) {
		if (message.direction !== "inbound" || message.kind === "bounce" || message.classification === "bounce" || message.classification === "relay_refused") continue;
		const at = new Date(message.occurredAt);
		if (message.decision) {
			// Taking the report on after acting on it (Cloudflare's `accepted` after it restricted access) changes nothing.
			if (!(current?.decision.outcome === "action_taken" && message.decision.outcome === "received")) current = { decision: message.decision, at };
			continue;
		}
		const generic = message.classification ? GENERIC[message.classification] : undefined;
		if (generic) {
			if (!current || !agrees(current.decision, message.classification!)) current = { decision: generic, at };
			continue;
		}
		if (message.providerState && (!current || current.decision.outcome === "received")) {
			current = { decision: { outcome: "received", label: "Under review", sentence: `Status “${message.providerState.state}”` }, at };
		}
	}
	return current;
}

const NOT_SENT_LABEL: Record<string, string> = {
	provider_rejected: "Refused by the provider's form",
	needs_human: "Stopped before sending",
	insufficient_evidence: "Not enough evidence for this form",
	no_route: "No contact found",
	discarded: "Not sent",
	delivery_failed: "Could not be delivered",
	failed: "Could not be sent",
};

/** Where one route stands, its label, its key line and its Sent → Received → Decision steps. */
export function routeStanding(route: SubmissionReportRoute): RouteStanding {
	const sentAt = route.outcome.sentAt ? new Date(route.outcome.sentAt) : undefined;
	if (route.status === "unknown_external_state") {
		return {
			bucket: "unconfirmed",
			label: "Not confirmed yet",
			line: `${route.organisation}'s answer to our submission was lost`,
			quoted: false,
			at: new Date(route.createdAt),
			steps: { sent: "unknown", received: "todo", decision: "todo" },
		};
	}
	if (route.outcome.verdict === "bounced" || route.outcome.verdict === "not_delivered") {
		return {
			bucket: "not_sent",
			label: route.outcome.verdict === "bounced" ? "Bounced" : NOT_SENT_LABEL[route.status] ?? "Not sent",
			...(route.error ? { line: route.error } : {}),
			quoted: false,
			at: new Date(route.updatedAt),
			steps: { sent: "negative", received: "todo", decision: "todo" },
		};
	}
	if (route.outcome.verdict === "pending") {
		return { bucket: "waiting", label: "Being sent", quoted: false, steps: { sent: "waiting", received: "todo", decision: "todo" } };
	}

	const decided = decisionOf(route.messages);
	if (decided) {
		const { decision, at } = decided;
		const bucket: RouteBucket = decision.outcome === "action_taken" ? "action_taken" : decision.outcome === "received" ? "received" : "declined";
		return {
			bucket,
			label: decision.label,
			...(decision.sentence ? { line: decision.excerpt ?? decision.sentence } : {}),
			quoted: Boolean(decision.sentence) && !decision.sentence!.startsWith("Status “"),
			at,
			steps: { sent: "done", received: "done", decision: bucket === "action_taken" ? "done" : bucket === "declined" ? "negative" : "waiting" },
		};
	}
	const reply = [...route.messages].sort(bySent).find((message) => message.direction === "inbound" && message.text);
	if (reply) {
		const lead = leadSentence(reply.text!.main);
		return { bucket: "received", label: "Answered, no decision yet", ...(lead ? { line: lead } : {}), quoted: Boolean(lead), at: new Date(reply.occurredAt), steps: { sent: "done", received: "done", decision: "waiting" } };
	}
	if (route.routeType !== "email") {
		// A form or API that took the report is its receipt.
		return { bucket: "received", label: "Received", ...(route.confirmationText ? { line: route.confirmationText } : {}), quoted: false, ...(sentAt ? { at: sentAt } : {}), steps: { sent: "done", received: "done", decision: "waiting" } };
	}
	return {
		bucket: "waiting",
		label: "Awaiting reply",
		line: route.recipient ? `Emailed ${route.recipient}` : "Emailed",
		quoted: false,
		...(sentAt ? { at: sentAt } : {}),
		steps: { sent: "done", received: "waiting", decision: "todo" },
	};
}

/** "19:21" on the day of `reference`, "27 Nov 19:21" on another, in UTC. */
export function shortUtc(at: Date | string, reference?: Date | string): string {
	const date = new Date(at);
	const time = date.toISOString().slice(11, 16);
	if (reference && new Date(reference).toISOString().slice(0, 10) === date.toISOString().slice(0, 10)) return time;
	return `${date.getUTCDate()} ${date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${time}`;
}

/**
 * What happens next on a route that is not settled, from what is queued: the
 * next look for a lost report's receipt, our answer to a decision, the next
 * read of the provider's status; and what is known about a "no threat"
 * verdict. Undefined for a settled route: an action, or a report that never
 * went out.
 */
export function nextStep(route: SubmissionReportRoute, standing: RouteStanding, reference?: Date | string): string | undefined {
	if (standing.bucket === "action_taken" || standing.bucket === "not_sent") return undefined;
	const next = (kind: SubmissionReportRoute["nextWork"][number]["kind"]) => route.nextWork.find((work) => work.kind === kind);
	const answered = route.decisionFollowUps.filter((followUp) => followUp.outcome === "replied").at(-1);
	const parts: string[] = [];
	const lookup = next("receipt_lookup");
	if (standing.bucket === "unconfirmed") {
		parts.push(lookup
			? `Looking for the report in ${route.organisation}'s list of received reports at ${shortUtc(lookup.at, reference)} UTC.`
			: `No further automatic check; the report is looked into by hand.`);
	}
	if (standing.bucket === "declined") {
		const latest = decisionOf(route.messages)?.decision;
		if (latest?.outcome === "no_threat" && !answered) parts.push(`Nothing more is planned: ${route.organisation}'s automatic scan found no threat.`);
		if (answered) parts.push(`We answered with evidence at ${shortUtc(answered.occurredAt, reference)} UTC; awaiting ${route.organisation}'s review.`);
	}
	const answer = next("decision_answer");
	if (answer) parts.push(`Answering ${route.organisation}'s decision at ${shortUtc(answer.at, reference)} UTC.`);
	const sending = next("submission");
	if (sending && standing.bucket === "waiting") parts.push(`Sending at ${shortUtc(sending.at, reference)} UTC.`);
	const check = next("status_check");
	if (check) parts.push(`Next status check at ${shortUtc(check.at, reference)} UTC.`);
	if (standing.bucket === "waiting" && route.routeType === "email" && !parts.length && standing.label === "Awaiting reply") parts.push(`Nothing more is planned until ${route.organisation} replies; its reply is read automatically.`);
	return parts.length ? parts.join(" ") : undefined;
}

/** One entry of a route's timeline, oldest first. */
export type TimelineEntry =
	| { kind: "reported"; at: Date; title: string; receipt: string | null; sent: string | null; confirmation: string | null; recipient: string | null }
	| { kind: "states"; states: Array<{ state: string; detail: string | null; at: Date }> }
	| { kind: "message"; at: Date; inbound: boolean; title: string; subject: string | null; sentence?: string; highlight: boolean; text: CleanMailText | null; rawArtifactId: bigint | null; failed: boolean; decision: ProviderDecision["outcome"] | null }
	| { kind: "not_answered"; at: Date; decision: string; explanation: string }
	| { kind: "next_hop"; at: Date; routeId: bigint; organisation: string; role: SubmissionReportRoute["role"] };

/** Who answered: the provider by name; a bounce or our own relay is not the provider. */
function messageTitle(route: SubmissionReportRoute, message: SubmissionReportMessage): string {
	if (message.direction === "outbound") return message.decisionReply ? "We answered the decision" : "We wrote";
	if (message.classification === "relay_refused") return "Our mail relay refused the report";
	if (message.kind === "bounce" || message.classification === "bounce") return "Delivery failed";
	return `${route.organisation} replied`;
}

/**
 * A route's history as one timeline: what we sent, consecutive review-state
 * records merged into one line ("submitted 18:51 → accepted 19:05"), each
 * message by its key sentence (a decision highlighted), decisions we chose not
 * to answer, and the reports this route's answer led to ("next hop").
 */
export function routeTimeline(route: SubmissionReportRoute, siblings: readonly SubmissionReportRoute[]): TimelineEntry[] {
	const messages = [...route.messages].sort(bySent);
	const report = route.routeType === "email" ? messages.find((message) => message.direction === "outbound" && !message.decisionReply) : undefined;
	const reportedAt = report ? new Date(report.occurredAt) : route.outcome.sentAt ? new Date(route.outcome.sentAt) : new Date(route.createdAt);
	const entries: TimelineEntry[] = [{
		kind: "reported",
		at: reportedAt,
		title: route.routeType === "email" ? `We emailed ${route.recipient ?? route.organisation}` : `We reported through ${route.organisation}'s ${route.channel}`,
		receipt: route.confirmationId,
		sent: report?.text ? [report.subject, report.text.main].filter(Boolean).join("\n\n") : route.body,
		confirmation: route.confirmationText,
		recipient: route.recipient,
	}];
	const answered = route.decisionFollowUps.filter((followUp) => followUp.outcome === "replied");
	let answers = 0;
	for (const message of messages) {
		if (message === report) continue;
		const at = new Date(message.occurredAt);
		if (message.providerState) {
			const last = entries.at(-1);
			const state = { state: message.providerState.state, detail: message.providerState.detail, at };
			if (last?.kind === "states") last.states.push(state);
			else entries.push({ kind: "states", states: [state] });
			continue;
		}
		const explanation = message.decisionReply ? answered[answers++]?.explanation : undefined;
		const sentence = message.decision?.sentence ?? explanation ?? (message.text ? leadSentence(message.text.main) : undefined);
		entries.push({
			kind: "message",
			at,
			inbound: message.direction === "inbound",
			title: messageTitle(route, message),
			subject: message.subject,
			...(sentence ? { sentence } : {}),
			highlight: Boolean(message.decision?.sentence),
			text: message.text,
			rawArtifactId: message.rawArtifactId,
			failed: message.kind === "bounce" || message.classification === "bounce" || message.classification === "relay_refused",
			decision: message.decision?.outcome ?? null,
		});
	}
	for (const followUp of route.decisionFollowUps.filter((item) => item.outcome === "not_replied")) {
		entries.push({ kind: "not_answered", at: new Date(followUp.occurredAt), decision: followUp.decision, explanation: followUp.explanation });
	}
	for (const hop of siblings.filter((sibling) => sibling.namedBy?.routeId === route.id)) {
		const at = hop.outcome.sentAt ?? hop.createdAt;
		entries.push({ kind: "next_hop", at: new Date(at), routeId: hop.id, organisation: hop.organisation, role: hop.role });
	}
	const time = (entry: TimelineEntry) => (entry.kind === "states" ? entry.states[0]!.at : entry.at).getTime();
	return [entries[0]!, ...entries.slice(1).sort((a, b) => time(a) - time(b))];
}

/** How the case page names what a report is about. */
export function subjectLabel(report: Pick<SubmissionReport, "subject" | "allegationCategory">): string {
	const labels: Record<ReportSubject, string> = {
		site: report.allegationCategory === "malware" ? "Malware site" : "Phishing site",
		email: "Phishing email",
		payload_host: "Payload host",
		data_drop: "Data drop",
		redirector: "Redirector",
		funnel: "Affiliate funnel",
		linked: "Linked host",
	};
	return labels[report.subject];
}

export type RouteEntry = { report: SubmissionReport; route: SubmissionReportRoute; standing: RouteStanding };

/** Every route of every report with its standing, the strongest outcome first; ties by the earliest standing. */
export function rankedRoutes(reports: readonly SubmissionReport[]): RouteEntry[] {
	const entries = reports.flatMap((report) => report.routes.map((route) => ({ report, route, standing: routeStanding(route) })));
	return entries.sort((a, b) => routeBuckets.indexOf(a.standing.bucket) - routeBuckets.indexOf(b.standing.bucket)
		|| (a.standing.at?.getTime() ?? Infinity) - (b.standing.at?.getTime() ?? Infinity));
}

export type TakedownSummary = {
	counts: Record<RouteBucket, number>;
	total: number;
	targets: number;
	providers: number;
	/** The strongest outcome of any route. */
	best?: RouteEntry;
	/** Reports of other cases this case's sites joined, and cases that joined this case's reports. */
	coveredBy: string[];
	alsoCovers: string[];
};

/** The case's takedown status: counts by standing, what was reached, and which cases share the reports. */
export function takedownSummary(reports: readonly SubmissionReport[], caseId?: string): TakedownSummary {
	const ranked = rankedRoutes(reports);
	const counts = Object.fromEntries(routeBuckets.map((bucket) => [bucket, 0])) as Record<RouteBucket, number>;
	for (const { standing } of ranked) counts[standing.bucket]++;
	const coveredBy = [...new Set(reports.filter((report) => caseId !== undefined && report.submissionId !== null && String(report.submissionId) !== caseId).map((report) => String(report.submissionId)))];
	const alsoCovers = [...new Set(reports.flatMap((report) => report.joinedCases.map(String)))].filter((id) => id !== caseId);
	return {
		counts,
		total: ranked.length,
		targets: new Set(reports.map((report) => report.target ?? String(report.id))).size,
		providers: new Set(ranked.map(({ route }) => route.organisation)).size,
		...(ranked[0] ? { best: ranked[0] } : {}),
		coveredBy,
		alsoCovers,
	};
}

/** The report's own standing, for a place that shows one report in a line: its strongest route's. */
export function reportStanding(report: SubmissionReport): RouteStanding | undefined {
	return rankedRoutes([report])[0]?.standing;
}
