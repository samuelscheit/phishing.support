import { describe, expect, test } from "bun:test";

import { describeDecisionFollowUp } from "./describe";

const at = new Date("2026-11-16T14:28:00Z");

describe("decision follow-up summaries", () => {
	test("an answer is told in the agent's own words, with where it went", () => {
		expect(describeDecisionFollowUp({
			eventType: "provider_decision.followed_up",
			createdAt: at,
			data: { state: "denied", detail: "no_abuse_found", to: "abusereply@cloudflare.com", summary: "The page still serves its command to Macs; asked them to open it as one." },
		})).toEqual({ outcome: "replied", decision: "no_abuse_found", explanation: "The page still serves its command to Macs; asked them to open it as one. Sent to abusereply@cloudflare.com.", occurredAt: at });
	});

	test("no answer carries the agent's reason; a long remark is named by the decision's state", () => {
		// Eranet's remark on binanceusa.org (receipt 19ef5c75-…) is a paragraph, not a code.
		expect(describeDecisionFollowUp({
			eventType: "provider_decision.not_answered",
			createdAt: at,
			data: { state: "supplement required", detail: "Based on the materials you have provided, we are unable to determine whether the website has committed any violations.", reason: "The payload host no longer answers; there is nothing new to show them." },
		})).toEqual({ outcome: "not_replied", decision: "supplement required", explanation: "The payload host no longer answers; there is nothing new to show them.", occurredAt: at });
	});

	test("other events are not follow-ups", () => {
		expect(describeDecisionFollowUp({ eventType: "route.status_changed", createdAt: at, data: {} })).toBeUndefined();
	});
});
