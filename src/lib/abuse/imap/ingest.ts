import { persistInboundAbuseMail } from "../mail";
import { getPortalProvider, listPortalProviders } from "../providers";
import { AbuseRepository } from "../repository";
import type { AbuseImapConfig, AbuseMailIngestResult, FetchedAbuseMail } from "./types";
import { flattenAddresses, headerStrings, isSeen, messageBody, normalizeMailbox, normalizeMessageId, parseAbuseMail, recipients, references } from "./rfc";

type AbuseMailIngestConfig = Pick<AbuseImapConfig, "mailbox" | "processSeen"> & { uidValidity: number };

async function findProviderInboundRoute(params: {
	senderAddresses: string[];
	recipients: string[];
	textBody: string;
}) {
	const matches = (await Promise.all(listPortalProviders().flatMap((provider) => provider.findInboundRoute ? [provider.findInboundRoute(params)] : [])))
		.filter((route): route is NonNullable<typeof route> => Boolean(route));
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Parse and persist one abuse-mail message without any dependency on the
 * legacy public-intake/case tables. Raw MIME and attachments are persisted by
 * persistInboundAbuseMail before the classifier or provider-specific
 * post-ingest handler is queued.
 */
export async function ingestFetchedAbuseMail(
	message: FetchedAbuseMail,
	config: AbuseMailIngestConfig,
): Promise<AbuseMailIngestResult> {
	try {
		if (!config.processSeen && isSeen(message.flags)) return { disposition: "terminal", route: "ignored", reason: "already_seen" };
		const raw = message.source ? Buffer.from(message.source) : undefined;
		if (!raw?.byteLength) throw new Error("Abuse IMAP fetch did not include the RFC 5322 source.");
		const parsed = await parseAbuseMail(raw);
		const messageId = normalizeMessageId(parsed.messageId ?? headerStrings(parsed, "message-id")[0] ?? message.envelope?.messageId);
		const inReplyTo = normalizeMessageId(parsed.inReplyTo ?? headerStrings(parsed, "in-reply-to")[0]);
		const recipientAddresses = recipients(parsed, message);
		const body = messageBody(parsed);
		const messageReferences = references(parsed);
		const hasExplicitCorrelationHeader = headerStrings(parsed, "in-reply-to").length > 0
			|| headerStrings(parsed, "references").length > 0
			|| Boolean(inReplyTo)
			|| messageReferences.length > 0;
		// Explicit Reply-To / Message-ID correlation always wins. Provider
		// shared-mailbox matching is a deliberately second, ambiguity-rejecting
		// path for messages that cannot be tied to an outbound message.
		const correlation = await AbuseRepository.findCorrelatedInboundRoute({ recipients: recipientAddresses, inReplyTo, references: messageReferences });
		const route = correlation.matched || hasExplicitCorrelationHeader
			? correlation.route
			: await findProviderInboundRoute({
			senderAddresses: flattenAddresses(parsed.from)
				.map((entry) => normalizeMailbox(entry.address))
				.filter((address): address is string => Boolean(address)),
			recipients: recipientAddresses,
			textBody: body,
			});
		if (!route) return { disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" };

		const existingByMessageId = messageId ? await AbuseRepository.getInboundMailByMessageId(messageId) : undefined;
		if (existingByMessageId) {
			// A prior persistence attempt may have succeeded while its provider
			// follow-up failed. Re-run that durable hook, but always use the route
			// stored with the original message rather than the current correlation.
			const existingRoute = await AbuseRepository.getRoute(existingByMessageId.routeId);
			await AbuseRepository.ensureInboundReplyClassification(existingByMessageId.id);
			const provider = existingRoute ? getPortalProvider(existingRoute.providerRegistryKey) : undefined;
			if (provider?.onInboundMessageStored) {
				await provider.onInboundMessageStored({
					routeId: existingByMessageId.routeId,
					reportId: existingByMessageId.reportId,
					messageId: existingByMessageId.id,
				});
			}
			return { disposition: "terminal", route: "reply", reason: "duplicate_message_id", messageId: existingByMessageId.id };
		}
		const stored = await persistInboundAbuseMail({
			routeId: route.id,
			reportId: route.reportId,
			recipientAddresses,
			rawMime: raw,
			mailbox: config.mailbox,
			uidValidity: config.uidValidity,
			uid: message.uid,
		});
		const provider = getPortalProvider(route.providerRegistryKey);
		if (provider?.onInboundMessageStored) await provider.onInboundMessageStored({ routeId: route.id, reportId: route.reportId, messageId: stored.messageId });
		if (!stored.created) return { disposition: "terminal", route: "reply", reason: "duplicate_imap_delivery", messageId: stored.messageId };
		return { disposition: "terminal", route: "reply", reason: "stored_abuse_reply", messageId: stored.messageId };
	} catch (error) {
		return { disposition: "retry", reason: error instanceof Error ? error.message : String(error) };
	}
}
