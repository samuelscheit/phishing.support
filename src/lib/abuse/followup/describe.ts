/**
 * What a provider-decision follow-up did, as the case page tells it: whether
 * the agent answered and why, from the event `followup/decision.ts` recorded.
 */
export type DecisionFollowUpSummary = {
	outcome: "replied" | "not_replied";
	/** The provider's decision: a short code such as `no_abuse_found`, or its state such as `supplement required`. */
	decision: string;
	/** In the agent's own words: why it answered and what it asked for, or why it sent nothing. */
	explanation: string;
	occurredAt: Date;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A short decision code names the decision; a long remark (Eranet's) is told by the explanation, so its state names it. */
const MAX_DECISION_LABEL = 40;

export function describeDecisionFollowUp(event: { eventType: string; data: unknown; createdAt: Date }): DecisionFollowUpSummary | undefined {
	const data = record(event.data) ?? {};
	const detail = text(data.detail);
	const decision = detail && detail.length <= MAX_DECISION_LABEL ? detail : text(data.state) ?? "decision";
	if (event.eventType === "provider_decision.followed_up") {
		const to = text(data.to) ?? "the provider";
		return { outcome: "replied", decision, explanation: `${text(data.summary) ?? "An answer was sent."} Sent to ${to}.`, occurredAt: event.createdAt };
	}
	if (event.eventType === "provider_decision.not_answered") {
		return { outcome: "not_replied", decision, explanation: text(data.reason) ?? "No answer was sent.", occurredAt: event.createdAt };
	}
	return undefined;
}
