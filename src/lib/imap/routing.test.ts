import { describe, expect, test } from "bun:test";

import { resolveIncomingMailRoute, type ReportThreadLookup } from "./routing";

function lookup(params: {
	reply?: Record<string, bigint[]>;
	messageId?: Record<string, bigint[]>;
	diagnostic?: Record<string, bigint[]>;
} = {}): ReportThreadLookup {
	return {
		byReplyAddress: new Map(Object.entries(params.reply ?? {})),
		byOutboundMessageId: new Map(Object.entries(params.messageId ?? {})),
		byDiagnosticToken: new Map(Object.entries(params.diagnostic ?? {})),
	};
}

const intakeAddress = "report@phishing.support";
const threadOne = 101n;
const threadTwo = 202n;

describe("strict report-thread routing", () => {
	test("uses an exact generated recipient before thread headers", () => {
		const route = resolveIncomingMailRoute(
			{
				recipients: ["Abuse Mail <CASE-ONE@Phishing.Support>"],
				inReplyTo: "<outbound-two@example.test>",
				intakeAddress,
			},
			lookup({
				reply: { "case-one@phishing.support": [threadOne] },
				messageId: { "<outbound-two@example.test>": [threadOne] },
			}),
		);

		expect(route).toEqual({ route: "reply", threadId: threadOne, matchedBy: "reply_address" });
	});

	test("uses In-Reply-To, then References, then the unique diagnostic token", () => {
		expect(
			resolveIncomingMailRoute(
				{ recipients: [], inReplyTo: "<OUTBOUND-ONE@example.test>", intakeAddress },
				lookup({ messageId: { "<outbound-one@example.test>": [threadOne] } }),
			),
		).toEqual({ route: "reply", threadId: threadOne, matchedBy: "in_reply_to" });

		expect(
			resolveIncomingMailRoute(
				{ recipients: [], references: ["<other@example.test>", "<OUTBOUND-TWO@example.test>"], intakeAddress },
				lookup({ messageId: { "<outbound-two@example.test>": [threadTwo] } }),
			),
		).toEqual({ route: "reply", threadId: threadTwo, matchedBy: "references" });

		expect(
			resolveIncomingMailRoute(
				{ recipients: [], diagnosticThreadToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", intakeAddress },
				lookup({ diagnostic: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: [threadOne] } }),
			),
		).toEqual({ route: "reply", threadId: threadOne, matchedBy: "diagnostic" });
	});

	test("ignores conflicting signals rather than choosing a potentially wrong thread", () => {
		const route = resolveIncomingMailRoute(
			{
				recipients: ["case-one@phishing.support"],
				inReplyTo: "<outbound-two@example.test>",
				intakeAddress,
			},
			lookup({
				reply: { "case-one@phishing.support": [threadOne] },
				messageId: { "<outbound-two@example.test>": [threadTwo] },
			}),
		);

		expect(route).toEqual({ route: "ignored", reason: "ambiguous_thread_signals" });
	});

	test("does not ignore conflicting identifiers within one repeated header", () => {
		expect(
			resolveIncomingMailRoute(
				{
					recipients: [],
					inReplyTo: ["<outbound-one@example.test>", "<outbound-two@example.test>"],
					intakeAddress,
				},
				lookup({
					messageId: {
						"<outbound-one@example.test>": [threadOne],
						"<outbound-two@example.test>": [threadTwo],
					},
				}),
			),
		).toEqual({ route: "ignored", reason: "ambiguous_thread_signals" });

		expect(
			resolveIncomingMailRoute(
				{
					recipients: [],
					diagnosticThreadToken: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
					intakeAddress,
				},
				lookup({
					diagnostic: {
						aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: [threadOne],
						bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: [threadTwo],
					},
				}),
			),
		).toEqual({ route: "ignored", reason: "ambiguous_thread_signals" });
	});

	test("falls back only to the configured intake address and otherwise ignores mail", () => {
		expect(resolveIncomingMailRoute({ recipients: ["Report <REPORT@phishing.support>"], intakeAddress }, lookup())).toEqual({ route: "intake" });
		expect(resolveIncomingMailRoute({ recipients: ["other@phishing.support"], intakeAddress }, lookup())).toEqual({
			route: "ignored",
			reason: "no_report_thread_match",
		});
	});
});
