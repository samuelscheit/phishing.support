import type { ParsedMail } from "mailparser";

import { flattenAddresses, headerStrings, messageBody, normalizeMailbox, normalizeMessageId, references } from "../imap/rfc";
import type { AbuseProviderRoute } from "./schema";
import { persistInboundAbuseMail, type InboundMailKind } from "./mail";
import { authenticatedSender, caseSubmissionIdsIn, caseTagsIn, deliveryFailure } from "./mail/correlation";
import { getPortalProvider, listPortalProviders, listProviderSubmissionProviders } from "./providers";
import { registrableDomain } from "./security";
import { AbuseRepository } from "./repository";

export type ProviderReplyMatch =
	/**
	 * The message correlates with exactly one report route. A bounce names the
	 * outbound Message-IDs it returned, which settle that delivery.
	 */
	| { kind: "reply"; route: AbuseProviderRoute; mailKind: InboundMailKind; bouncedMessageIds?: string[] }
	/** A provider notification whose content its API already supplies. */
	| { kind: "provider_api" }
	/** The message names one of our reports but cannot be tied to exactly one route. */
	| { kind: "ambiguous" }
	| { kind: "none" };

async function findProviderInboundRoute(params: { senderAddresses: string[]; recipients: string[]; textBody: string }) {
	const matches = (await Promise.all(listPortalProviders().flatMap((provider) => provider.findInboundRoute ? [provider.findInboundRoute(params)] : [])))
		.filter((route): route is NonNullable<typeof route> => Boolean(route));
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Mail from a direct provider's authenticated notification domain belongs to
 * the route whose receipt it names. A provider without receipt matching reads
 * its correspondence from its API, so its mail is not attached again.
 */
async function matchProviderNotification(sender: string, text: string): Promise<ProviderReplyMatch | undefined> {
	const domain = registrableDomain(sender.slice(sender.lastIndexOf("@") + 1));
	const providers = listProviderSubmissionProviders().filter((provider) => provider.inboundMail?.senderDomains.includes(domain ?? ""));
	if (providers.length === 0) return undefined;
	const matchers = providers.filter((provider) => provider.inboundMail?.confirmationIds);
	if (matchers.length === 0) return { kind: "provider_api" };
	const route = await AbuseRepository.findRouteByConfirmationId({
		providerRegistryKeys: matchers.map((provider) => provider.definition.key),
		confirmationIds: [...new Set(matchers.flatMap((provider) => provider.inboundMail!.confirmationIds!(text)))],
	});
	return route ? { kind: "reply", route, mailKind: "notification" } : { kind: "none" };
}

/**
 * The receiving mail server whose Authentication-Results are trusted to vouch
 * for a sender (iCloud for the service mailbox).
 */
const TRUSTED_AUTHSERV_ID = "icloud.com";

/**
 * Correlate inbound mail with a sent report, strongest evidence first:
 * 1. our generated Reply-To identity or one of our Message-IDs in
 *    In-Reply-To/References (a bounce names ours in its returned headers);
 * 2. an authenticated sender we emailed, plus our case tag or case URL;
 * 3. an authenticated sender we emailed, plus our exact original subject;
 * 4. a provider-owned shared-mailbox matcher.
 * A message that names several routes attaches to none.
 */
export async function matchProviderReply(parsed: ParsedMail, recipientAddresses: string[]): Promise<ProviderReplyMatch> {
	const inReplyTo = normalizeMessageId(parsed.inReplyTo ?? headerStrings(parsed, "in-reply-to")[0]);
	const messageReferences = references(parsed);
	const correlation = await AbuseRepository.findCorrelatedInboundRoute({ recipients: recipientAddresses, inReplyTo, references: messageReferences });
	if (correlation.route) return { kind: "reply", route: correlation.route, mailKind: "reply" };
	if (correlation.matched) return { kind: "ambiguous" };

	const bounce = deliveryFailure(parsed);
	if (bounce) {
		const route = await AbuseRepository.findBouncedOutboundRoute(bounce.messageIds);
		return route ? { kind: "reply", route, mailKind: "bounce", bouncedMessageIds: bounce.messageIds } : { kind: "none" };
	}

	const sender = authenticatedSender(parsed, TRUSTED_AUTHSERV_ID);
	const body = messageBody(parsed);
	const notification = sender ? await matchProviderNotification(sender, `${parsed.subject ?? ""}\n${body}`) : undefined;
	if (notification) return notification;
	if (sender) {
		const searchable = `${parsed.subject ?? ""}\n${body}`;
		const bySender = await AbuseRepository.findReplyRouteForSender({
			sender,
			caseTags: caseTagsIn(searchable),
			submissionIds: caseSubmissionIdsIn(searchable),
			subject: parsed.subject ?? "",
		});
		if (bySender.route) return { kind: "reply", route: bySender.route, mailKind: "reply" };
		if (bySender.matched) return { kind: "ambiguous" };
	}

	// A message answering some other conversation must not be attached to a
	// report by the provider shared-mailbox heuristic.
	if (inReplyTo || messageReferences.length > 0) return { kind: "none" };
	const route = await findProviderInboundRoute({
		senderAddresses: flattenAddresses(parsed.from)
			.map((entry) => normalizeMailbox(entry.address))
			.filter((address): address is string => Boolean(address)),
		recipients: recipientAddresses,
		textBody: body,
	});
	return route ? { kind: "reply", route, mailKind: "reply" } : { kind: "none" };
}

/**
 * Persist one provider reply with its raw MIME and attachments, queue its
 * classifier, and run any provider post-storage hook exactly once per
 * message. Replays of the same UID or RFC Message-ID resolve to the stored row.
 */
export async function storeProviderReply(params: {
	route: AbuseProviderRoute;
	mailKind: InboundMailKind;
	bouncedMessageIds?: string[];
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
		kind: params.mailKind,
		...(params.bouncedMessageIds ? { bouncedMessageIds: params.bouncedMessageIds } : {}),
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
