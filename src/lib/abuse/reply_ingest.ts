import type { ParsedMail } from "mailparser";

import { flattenAddresses, headerStrings, messageBody, normalizeMailbox, normalizeMessageId, references } from "../imap/rfc";
import type { AbuseProviderRoute } from "./schema";
import { persistInboundAbuseMail } from "./mail";
import { getPortalProvider, listPortalProviders } from "./providers";
import { AbuseRepository } from "./repository";

export type ProviderReplyMatch =
	/** The message correlates with exactly one report route. */
	| { kind: "reply"; route: AbuseProviderRoute }
	/** The message names one of our reports but cannot be tied to exactly one route. */
	| { kind: "ambiguous" }
	| { kind: "none" };

async function findProviderInboundRoute(params: { senderAddresses: string[]; recipients: string[]; textBody: string }) {
	const matches = (await Promise.all(listPortalProviders().flatMap((provider) => provider.findInboundRoute ? [provider.findInboundRoute(params)] : [])))
		.filter((route): route is NonNullable<typeof route> => Boolean(route));
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Correlate inbound mail with a sent report. Explicit Reply-To / Message-ID
 * correlation always wins; provider shared-mailbox matching is a second,
 * ambiguity-rejecting path for messages without correlation headers. Sender,
 * subject, and body text never select a report on their own.
 */
export async function matchProviderReply(parsed: ParsedMail, recipientAddresses: string[]): Promise<ProviderReplyMatch> {
	const inReplyTo = normalizeMessageId(parsed.inReplyTo ?? headerStrings(parsed, "in-reply-to")[0]);
	const messageReferences = references(parsed);
	const correlation = await AbuseRepository.findCorrelatedInboundRoute({ recipients: recipientAddresses, inReplyTo, references: messageReferences });
	if (correlation.route) return { kind: "reply", route: correlation.route };
	if (correlation.matched) return { kind: "ambiguous" };
	// A message that answers some other conversation must not be attached to a
	// report by the weaker shared-mailbox heuristics.
	if (inReplyTo || messageReferences.length > 0 || headerStrings(parsed, "in-reply-to").length > 0) return { kind: "none" };
	const route = await findProviderInboundRoute({
		senderAddresses: flattenAddresses(parsed.from)
			.map((entry) => normalizeMailbox(entry.address))
			.filter((address): address is string => Boolean(address)),
		recipients: recipientAddresses,
		textBody: messageBody(parsed),
	});
	return route ? { kind: "reply", route } : { kind: "none" };
}

/**
 * Persist one provider reply with its raw MIME and attachments, queue its
 * classifier, and run any provider post-storage hook exactly once per
 * message. Replays of the same UID or RFC Message-ID resolve to the stored row.
 */
export async function storeProviderReply(params: {
	route: AbuseProviderRoute;
	parsed: ParsedMail;
	raw: Buffer;
	recipientAddresses: string[];
	mailbox: string;
	uidValidity: number;
	uid: number;
}): Promise<{ messageId: bigint; reason: "stored_provider_reply" | "duplicate_message_id" | "duplicate_imap_delivery" }> {
	const messageId = normalizeMessageId(params.parsed.messageId ?? headerStrings(params.parsed, "message-id")[0]);
	const existing = messageId ? await AbuseRepository.getInboundMailByMessageId(messageId) : undefined;
	if (existing) {
		// A prior attempt may have stored the message while its follow-up
		// failed. Re-run the durable hooks against the originally stored route.
		await AbuseRepository.ensureInboundReplyClassification(existing.id);
		const existingRoute = await AbuseRepository.getRoute(existing.routeId);
		const provider = existingRoute ? getPortalProvider(existingRoute.providerRegistryKey) : undefined;
		await provider?.onInboundMessageStored?.({ routeId: existing.routeId, reportId: existing.reportId, messageId: existing.id });
		return { messageId: existing.id, reason: "duplicate_message_id" };
	}
	const stored = await persistInboundAbuseMail({
		routeId: params.route.id,
		reportId: params.route.reportId,
		recipientAddresses: params.recipientAddresses,
		rawMime: params.raw,
		mailbox: params.mailbox,
		uidValidity: params.uidValidity,
		uid: params.uid,
	});
	const provider = getPortalProvider(params.route.providerRegistryKey);
	await provider?.onInboundMessageStored?.({ routeId: params.route.id, reportId: params.route.reportId, messageId: stored.messageId });
	return { messageId: stored.messageId, reason: stored.created ? "stored_provider_reply" : "duplicate_imap_delivery" };
}
