import { describe, expect, test } from "bun:test";

import { describeDecisionFollowUp } from "./describe";

const at = new Date("2026-11-05T23:05:00Z");

describe("decision follow-up summaries", () => {
	test("a phishing site the recheck could not load says so, with why nothing supported a reply", () => {
		// device.ledger-access.live (report of case 376311583464230933), rechecked on 2026-11-05.
		const summary = describeDecisionFollowUp({
			eventType: "provider_decision.not_contested",
			createdAt: at,
			data: {
				state: "denied",
				detail: "no_abuse_found",
				recheck: {
					kind: "website",
					checkedAt: "2026-11-05T23:07:30.000Z",
					recheck: { reached: false, failure: "Failed to load page: net::ERR_NAME_NOT_RESOLVED via Tor exit" },
					stillServed: false,
					capture: { at: "2026-11-04T09:30:00.000Z", url: "https://device.ledger-access.live/en/recovery", afterReview: false, timestamped: true },
					accountIdentifiers: [],
					references: [],
				},
			},
		});
		expect(summary).toEqual({
			outcome: "not_replied",
			decision: "no_abuse_found",
			occurredAt: at,
			explanation: "Our recheck at 2026-11-05T23:07:30.000Z could not load the site over Tor, the server IP, or the residential exit (Failed to load page: net::ERR_NAME_NOT_RESOLVED via Tor exit). Our last capture (2026-11-04T09:30:00.000Z) was made before the provider's review, so it cannot show the page was still up when they looked. No identifier in the kit's pages ties it to an account at the provider. No reply was sent.",
		});
	});

	test("a phishing site the recheck reached without the reported page names where it ended and how it was classified", () => {
		const summary = describeDecisionFollowUp({
			eventType: "provider_decision.not_contested",
			createdAt: at,
			data: {
				state: "denied",
				detail: "no_abuse_found",
				recheck: {
					checkedAt: "2026-11-05T23:06:00.000Z",
					recheck: { reached: true, url: "https://veopag.co/", route: "Tor exit", finding: { finding: "insufficient_evidence" }, matchesReportedKit: false },
					stillServed: false,
					accountIdentifiers: [],
				},
			},
		});
		expect(summary?.explanation).toBe("Our recheck at 2026-11-05T23:06:00.000Z reached https://veopag.co/ over the Tor exit, which no longer shows the reported page (classified insufficient evidence). The case has no capture of the reported page to cite. No reply was sent.");
	});

	test("an older live-check record says what our server fetched", () => {
		// paneo.work, 2026-11-03: the page answered Cloudflare's 523.
		const summary = describeDecisionFollowUp({
			eventType: "provider_decision.not_contested",
			createdAt: at,
			data: { state: "denied", detail: "no_abuse_found", liveChecks: [{ url: "https://paneo.work/", as: "a desktop browser", status: 523 }, { url: "https://docusign.alt3-doc3ea7-v2.sbs/word/verify.workspace.php", as: "a desktop browser", status: 200, bytes: 257 }] },
		});
		expect(summary?.explanation).toBe("Our server fetched https://paneo.work/ as a desktop browser: HTTP 523; https://docusign.alt3-doc3ea7-v2.sbs/word/verify.workspace.php as a desktop browser: HTTP 200, 257 bytes, and did not find the reported content. No reply was sent.");
	});

	test("a sent reply says which kind and where it went", () => {
		expect(describeDecisionFollowUp({ eventType: "provider_decision.followed_up", createdAt: at, data: { state: "denied", detail: "content_removed", replyKind: "account", to: "abusereply@cloudflare.com" } })).toEqual({
			outcome: "replied",
			decision: "content_removed",
			replyKind: "account",
			occurredAt: at,
			explanation: "The site was gone, but its pages carry an identifier of an account at the provider, so the reply to abusereply@cloudflare.com asks them to act on that account.",
		});
		expect(describeDecisionFollowUp({ eventType: "provider_decision.followed_up", createdAt: at, data: { state: "denied", detail: "no_abuse_found", replyKind: "contest", to: "abusereply@cloudflare.com" } })?.explanation)
			.toBe("Our recheck showed the reported page was still there (or was after their review), so the reply to abusereply@cloudflare.com asks them to review the report again.");
		expect(describeDecisionFollowUp({ eventType: "report.accepted", createdAt: at, data: {} })).toBeUndefined();
	});
});
