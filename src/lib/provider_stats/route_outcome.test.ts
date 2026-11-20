import { describe, expect, test } from "bun:test";

import type { AbuseMailClassification } from "../abuse/schema";
import { routeOutcomeOf, type RouteFacts, type RouteMessageFact } from "./route_outcome";

const at = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * 3_600_000);
const sent = (hours: number, correlationKey: string | null = "email-run:1"): RouteMessageFact => ({ direction: "outbound", kind: "report", status: "sent", classification: null, correlationKey, occurredAt: at(hours) });
const reply = (hours: number, classification: AbuseMailClassification | null, kind = "reply"): RouteMessageFact => ({ direction: "inbound", kind, status: "received", classification, correlationKey: null, occurredAt: at(hours) });
const facts = (overrides: Partial<RouteFacts>): RouteFacts => ({ routeType: "email", status: "awaiting_provider_reply", createdAt: at(-1), statusChanges: [], messages: [], unansweredDecisions: 0, ...overrides });

describe("routeOutcomeOf", () => {
	test("a delivered mail report without an answer is no reply, sent when the mail went out", () => {
		const outcome = routeOutcomeOf(facts({ messages: [sent(0)], statusChanges: [{ to: "awaiting_provider_reply", at: at(0.1) }] }));
		expect(outcome).toMatchObject({ verdict: "no_reply", sentAt: at(0), followUps: 0, outbound: 1, inbound: 0 });
		expect(outcome.firstReplyAt).toBeUndefined();
		expect(outcome.decisionAt).toBeUndefined();
	});

	test("an automatic receipt is the first reply; the later decision is the decision", () => {
		const outcome = routeOutcomeOf(facts({ status: "acknowledged", messages: [sent(0), reply(0.05, "ambiguous"), reply(30, "acknowledged")], statusChanges: [{ to: "awaiting_provider_reply", at: at(0) }] }));
		expect(outcome).toMatchObject({ verdict: "acknowledged", firstReplyAt: at(0.05), decisionAt: at(30), inbound: 2 });
	});

	test("the latest decisive answer wins, and a refusal turned into acceptance after a follow-up is overturned", () => {
		const outcome = routeOutcomeOf(facts({
			status: "provider_rejected",
			messages: [sent(0), reply(5, "rejected"), sent(6, "decision-follow-up:1:denied"), reply(20, "acknowledged")],
		}));
		expect(outcome).toMatchObject({ verdict: "acknowledged", decisionAt: at(5), followUps: 1, overturnedByFollowUp: true });
	});

	test("a follow-up that changed nothing is not an overturn", () => {
		const outcome = routeOutcomeOf(facts({ messages: [sent(0), reply(5, "rejected"), sent(6, "decision-follow-up:1:x"), reply(9, "rejected")] }));
		expect(outcome).toMatchObject({ verdict: "rejected", followUps: 1, overturnedByFollowUp: false });
	});

	test("an acceptance before any follow-up is not an overturn", () => {
		expect(routeOutcomeOf(facts({ messages: [sent(0), reply(1, "acknowledged"), sent(2, "decision-follow-up:1:x")] })).overturnedByFollowUp).toBe(false);
	});

	test("a direct submission's report is its API call: every message we send is a follow-up", () => {
		const outcome = routeOutcomeOf(facts({
			routeType: "provider_submission",
			status: "submitted",
			statusChanges: [{ to: "running", at: at(-0.5) }, { to: "submitted", at: at(0) }],
			messages: [reply(48, "rejected", "provider_api"), { ...sent(50, "decision-follow-up:1:denied"), kind: "provider_form" }],
			unansweredDecisions: 1,
		}));
		expect(outcome).toMatchObject({ verdict: "rejected", sentAt: at(0), decisionAt: at(48), followUps: 1, unansweredDecisions: 1 });
	});

	test("a review state our poll read without a verdict is no answer; one with a verdict is", () => {
		const status = (hours: number, state: string, classification: AbuseMailClassification | null) => ({ ...reply(hours, classification, "provider_api"), correlationKey: `provider-api:netcraft:status:7:${state}` });
		const polled = routeOutcomeOf(facts({ routeType: "provider_submission", status: "submitted", statusChanges: [{ to: "submitted", at: at(0) }], messages: [status(0.02, "processing", null)] }));
		expect(polled).toMatchObject({ verdict: "no_reply", inbound: 0 });
		expect(polled.firstReplyAt).toBeUndefined();
		const decided = routeOutcomeOf(facts({ routeType: "provider_submission", status: "submitted", statusChanges: [{ to: "submitted", at: at(0) }], messages: [status(0.02, "processing", null), status(3, "malicious", "acknowledged")] }));
		expect(decided).toMatchObject({ verdict: "acknowledged", firstReplyAt: at(3), decisionAt: at(3) });
		// A provider's own message without a classification is still an answer.
		expect(routeOutcomeOf(facts({ routeType: "provider_submission", status: "submitted", statusChanges: [{ to: "submitted", at: at(0) }], messages: [reply(2, null, "provider_api")] })).verdict).toBe("no_decision");
	});

	test("a later status change does not hide a delivered report or its answer", () => {
		// not_monitored reply → escalation to the provider's form, which then failed.
		for (const status of ["escalating_to_portal", "needs_human", "failed"] as const) {
			expect(routeOutcomeOf(facts({ status, messages: [sent(0), reply(0.1, "not_monitored")], statusChanges: [{ to: "awaiting_provider_reply", at: at(0) }, { to: "escalating_to_portal", at: at(0.1) }] })))
				.toMatchObject({ verdict: "not_monitored", sentAt: at(0) });
		}
		// Retries exhausted while waiting for a reply: delivered, unanswered.
		expect(routeOutcomeOf(facts({ status: "failed", messages: [sent(0)], statusChanges: [{ to: "awaiting_provider_reply", at: at(0) }, { to: "failed", at: at(200) }] })).verdict).toBe("no_reply");
	});

	test("delivery_failed is a bounce only when a bounce came back; otherwise the mail never left", () => {
		expect(routeOutcomeOf(facts({ status: "delivery_failed", messages: [{ ...sent(0), status: "failed" }], statusChanges: [{ to: "delivery_failed", at: at(0) }] })).verdict).toBe("not_delivered");
		expect(routeOutcomeOf(facts({ status: "delivery_failed", messages: [sent(0), reply(0.01, "bounce", "bounce")], statusChanges: [{ to: "delivery_failed", at: at(0.01) }] })).verdict).toBe("bounced");
		// An uncorrelated bounce makes the route provider_rejected; it is still a bounce.
		expect(routeOutcomeOf(facts({ status: "provider_rejected", messages: [sent(0), reply(0.01, "bounce", "bounce")], statusChanges: [{ to: "provider_rejected", at: at(0.01) }] })).verdict).toBe("bounced");
	});

	test("the automatic receipt of a follow-up does not overturn a refusal; a later acknowledgement does", () => {
		const receipt = routeOutcomeOf(facts({ messages: [sent(0), reply(5, "rejected"), sent(6, "decision-follow-up:1:x"), reply(6.05, "acknowledged")] }));
		expect(receipt).toMatchObject({ verdict: "rejected", decisionAt: at(5), overturnedByFollowUp: false });
		const real = routeOutcomeOf(facts({ messages: [sent(0), reply(5, "rejected"), sent(6, "decision-follow-up:1:x"), reply(6.05, "acknowledged"), reply(30, "acknowledged")] }));
		expect(real).toMatchObject({ verdict: "acknowledged", decisionAt: at(30), overturnedByFollowUp: true });
	});

	test("a report our own relay refused never reached the provider, whatever its route status said meanwhile", () => {
		const refused = { ...reply(0.01, "relay_refused", "bounce") };
		const outcome = routeOutcomeOf(facts({
			status: "delivery_failed",
			messages: [{ ...sent(0), status: "failed" }, refused],
			statusChanges: [{ to: "awaiting_provider_reply", at: at(0) }, { to: "delivery_failed", at: at(0.01) }],
		}));
		expect(outcome).toMatchObject({ verdict: "not_delivered", inbound: 0 });
		// Its resend went out: delivered from then on, unanswered.
		const resent = routeOutcomeOf(facts({
			status: "awaiting_provider_reply",
			messages: [{ ...sent(0), status: "failed" }, refused, sent(1, "email-run:1")],
			statusChanges: [{ to: "awaiting_provider_reply", at: at(0) }, { to: "delivery_failed", at: at(0.01) }, { to: "awaiting_provider_reply", at: at(1) }],
		}));
		expect(resent).toMatchObject({ verdict: "no_reply", sentAt: at(1), followUps: 0 });
	});

	test("a mail route without any outbound record is taken at its status history", () => {
		expect(routeOutcomeOf(facts({ status: "awaiting_provider_reply", statusChanges: [{ to: "awaiting_provider_reply", at: at(2) }] }))).toMatchObject({ verdict: "no_reply", sentAt: at(2) });
	});

	test("the decision is when the final verdict first stood", () => {
		expect(routeOutcomeOf(facts({ messages: [sent(0), reply(1, "acknowledged"), reply(2, "rejected"), reply(3, "rejected")] })).decisionAt).toEqual(at(2));
	});

	test("a submission the provider's form refused before filing was never delivered", () => {
		// Production: Safe Browsing's "Ein Fehler ist aufgetreten", Netcraft's "Duplicate of a recent submission".
		const refused = routeOutcomeOf(facts({ routeType: "provider_submission", status: "provider_rejected", statusChanges: [{ to: "running", at: at(0) }, { to: "provider_rejected", at: at(0.1) }] }));
		expect(refused).toMatchObject({ verdict: "not_delivered" });
		expect(refused.sentAt).toBeUndefined();
		// A mail route the provider refused by reply was delivered: the reply decides.
		expect(routeOutcomeOf(facts({ status: "provider_rejected", messages: [reply(1, "not_monitored")], statusChanges: [{ to: "provider_rejected", at: at(1) }] })).verdict).toBe("not_monitored");
	});

	test("a route status without a classified message still decides", () => {
		expect(routeOutcomeOf(facts({ routeType: "provider_submission", status: "provider_rejected", statusChanges: [{ to: "submitted", at: at(0) }, { to: "provider_rejected", at: at(3) }] })))
			.toMatchObject({ verdict: "rejected", decisionAt: at(3) });
		expect(routeOutcomeOf(facts({ status: "acknowledged", messages: [sent(0)], statusChanges: [{ to: "acknowledged", at: at(4) }] })))
			.toMatchObject({ verdict: "acknowledged", decisionAt: at(4) });
	});

	test("a mailbox nobody reads and a request for more are their own verdicts", () => {
		expect(routeOutcomeOf(facts({ status: "provider_rejected", messages: [sent(0), reply(0.1, "not_monitored")] })).verdict).toBe("not_monitored");
		expect(routeOutcomeOf(facts({ messages: [sent(0), reply(3, "needs_more_information")] })).verdict).toBe("needs_more_information");
	});

	test("a bounce is not a reply", () => {
		const outcome = routeOutcomeOf(facts({ status: "delivery_failed", messages: [sent(0), reply(0.01, "bounce", "bounce")] }));
		expect(outcome).toMatchObject({ verdict: "bounced", sentAt: at(0), inbound: 1 });
		expect(outcome.firstReplyAt).toBeUndefined();
		// A bounce classified on a reply is no reply either.
		expect(routeOutcomeOf(facts({ messages: [sent(0), reply(0.01, "bounce")] })).verdict).toBe("bounced");
	});

	test("a failed send is not the report, and our own failures are not the provider's", () => {
		const failedSend = { ...sent(0), status: "failed" };
		for (const status of ["failed", "unknown_external_state", "insufficient_evidence", "needs_human", "no_route", "discarded"] as const) {
			const outcome = routeOutcomeOf(facts({ status, messages: [failedSend] }));
			expect(outcome).toMatchObject({ verdict: "not_delivered", outbound: 0 });
			expect(outcome.sentAt).toBeUndefined();
		}
	});

	test("work still in flight is pending", () => {
		for (const status of ["awaiting_approval", "resolving", "verified", "queued", "running", "escalating_to_portal"] as const) {
			expect(routeOutcomeOf(facts({ status })).verdict).toBe("pending");
		}
	});

	test("messages are read in time order whatever order they were stored in", () => {
		const outcome = routeOutcomeOf(facts({ messages: [reply(20, "acknowledged"), reply(5, "rejected"), sent(0)] }));
		expect(outcome).toMatchObject({ verdict: "acknowledged", decisionAt: at(5), firstReplyAt: at(5), sentAt: at(0) });
	});
});
