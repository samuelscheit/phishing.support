/**
 * What a provider-decision follow-up did, as the case page tells it: whether
 * a reply was sent and why, from the event `followup/decision.ts` recorded.
 * Pure, so the wording stays next to the facts it restates.
 */
export type DecisionFollowUpSummary = {
	outcome: "replied" | "not_replied";
	/** The provider's decision, e.g. `content_removed` or `no_abuse_found`. */
	decision: string;
	/** Set on a reply: `contest` asked for another review, `account` asked them to act on the account. */
	replyKind?: "contest" | "account";
	explanation: string;
	occurredAt: Date;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** One live-check line: what our server got for a URL. */
function liveCheckResult(check: Record<string, unknown>): string | undefined {
	const url = text(check.url);
	if (!url) return undefined;
	const status = check.status === 200
		? `HTTP 200${typeof check.bytes === "number" ? `, ${check.bytes} bytes` : ""}`
		: check.status === "error" ? "no answer" : `HTTP ${String(check.status)}`;
	return `${url} as ${text(check.as) ?? "a browser"}: ${status}`;
}

/** Why a phishing site's recheck did not support a reply. */
function websiteNotContested(evidence: Record<string, unknown>): string {
	const recheck = record(evidence.recheck);
	const checkedAt = text(evidence.checkedAt);
	const when = checkedAt ? ` at ${checkedAt}` : "";
	const reached = recheck?.reached === true;
	const finding = text(record(recheck?.finding)?.finding);
	const seen = reached
		? `Our recheck${when} reached ${text(recheck?.url) ?? "the site"}${text(recheck?.route) ? ` over the ${text(recheck?.route)}` : ""}, which no longer shows the reported page${finding ? ` (classified ${finding.replaceAll("_", " ")})` : ""}.`
		: `Our recheck${when} could not load the site over Tor, the server IP, or the residential exit${text(recheck?.failure) ? ` (${text(recheck?.failure)})` : ""}.`;
	const capture = record(evidence.capture);
	return [
		seen,
		capture ? `Our last capture (${text(capture.at) ?? "unknown time"}) was made before the provider's review, so it cannot show the page was still up when they looked.` : "The case has no capture of the reported page to cite.",
		!reached ? "No identifier in the kit's pages ties it to an account at the provider." : undefined,
		"No reply was sent.",
	].filter(Boolean).join(" ");
}

/** Why a paste-command page or payload host's live check did not support a reply. */
function liveChecksNotContested(checks: unknown[]): string {
	const lines = checks.map((check) => liveCheckResult(record(check) ?? {})).filter((line): line is string => Boolean(line));
	return [
		lines.length ? `Our server fetched ${lines.join("; ")}, and did not find the reported content.` : "Our server could not fetch the reported content.",
		"No reply was sent.",
	].join(" ");
}

export function describeDecisionFollowUp(event: { eventType: string; data: unknown; createdAt: Date }): DecisionFollowUpSummary | undefined {
	const data = record(event.data) ?? {};
	const decision = text(data.detail) ?? text(data.state) ?? "denied";
	if (event.eventType === "provider_decision.followed_up") {
		const replyKind = data.replyKind === "account" ? "account" : "contest";
		const to = text(data.to) ?? "the provider";
		return {
			outcome: "replied",
			decision,
			replyKind,
			explanation: replyKind === "account"
				? `The site was gone, but its pages carry an identifier of an account at the provider, so the reply to ${to} asks them to act on that account.`
				: `Our recheck showed the reported page was still there (or was after their review), so the reply to ${to} asks them to review the report again.`,
			occurredAt: event.createdAt,
		};
	}
	if (event.eventType === "provider_decision.not_contested") {
		const evidence = record(data.recheck);
		return {
			outcome: "not_replied",
			decision,
			explanation: evidence ? websiteNotContested(evidence) : liveChecksNotContested(Array.isArray(data.liveChecks) ? data.liveChecks : []),
			occurredAt: event.createdAt,
		};
	}
	return undefined;
}
