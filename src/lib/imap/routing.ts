import {
	extractNormalizedAddresses,
	normalizeDiagnosticThreadToken,
	normalizeEmailAddress,
	parseMessageIdList,
} from "@/lib/report/correspondence";

export type ReportThreadLookup = {
	byReplyAddress: ReadonlyMap<string, readonly bigint[]>;
	byOutboundMessageId: ReadonlyMap<string, readonly bigint[]>;
	byDiagnosticToken: ReadonlyMap<string, readonly bigint[]>;
};

export type IncomingRouteSignals = {
	recipients: readonly string[];
	inReplyTo?: string | readonly string[] | null;
	references?: readonly string[];
	diagnosticThreadToken?: string | readonly string[] | null;
	intakeAddress: string;
};

export type ResolvedIncomingRoute =
	| { route: "reply"; threadId: bigint; matchedBy: "reply_address" | "in_reply_to" | "references" | "diagnostic" }
	| { route: "intake" }
	| { route: "ignored"; reason: "ambiguous_thread_signals" | "no_report_thread_match" };

function valuesFor(map: ReadonlyMap<string, readonly bigint[]>, keys: readonly string[]): bigint[] {
	const values = new Set<bigint>();
	for (const key of keys) {
		for (const id of map.get(key) ?? []) values.add(id);
	}
	return [...values];
}

function values(value: string | readonly string[] | null | undefined): readonly string[] {
	if (value === undefined || value === null) return [];
	return typeof value === "string" ? [value] : value;
}

/**
 * Resolves only deterministic correspondence identifiers. Sender, subject, and
 * body text are intentionally absent from this interface to make fuzzy routing
 * impossible by construction.
 */
export function resolveIncomingMailRoute(signals: IncomingRouteSignals, lookup: ReportThreadLookup): ResolvedIncomingRoute {
	const recipients = extractNormalizedAddresses([...signals.recipients]);
	const intakeAddress = normalizeEmailAddress(signals.intakeAddress) ?? signals.intakeAddress.trim().toLowerCase();
	const recipientThreads = valuesFor(lookup.byReplyAddress, recipients);
	const inReplyToThreads = valuesFor(lookup.byOutboundMessageId, parseMessageIdList(signals.inReplyTo));
	const referenceThreads = valuesFor(lookup.byOutboundMessageId, parseMessageIdList(signals.references));
	const diagnosticThreads = valuesFor(
		lookup.byDiagnosticToken,
		values(signals.diagnosticThreadToken)
			.map((value) => normalizeDiagnosticThreadToken(value))
			.filter((value): value is string => Boolean(value)),
	);

	const allThreads = new Set([...recipientThreads, ...inReplyToThreads, ...referenceThreads, ...diagnosticThreads]);
	if (allThreads.size > 1) return { route: "ignored", reason: "ambiguous_thread_signals" };

	const [threadId] = allThreads;
	if (threadId !== undefined) {
		if (recipientThreads.includes(threadId)) return { route: "reply", threadId, matchedBy: "reply_address" };
		if (inReplyToThreads.includes(threadId)) return { route: "reply", threadId, matchedBy: "in_reply_to" };
		if (referenceThreads.includes(threadId)) return { route: "reply", threadId, matchedBy: "references" };
		return { route: "reply", threadId, matchedBy: "diagnostic" };
	}

	if (recipients.includes(intakeAddress)) return { route: "intake" };
	return { route: "ignored", reason: "no_report_thread_match" };
}
