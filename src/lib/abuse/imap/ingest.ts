import { extractUnambiguousVerificationCode, persistInboundAbuseMail } from "../mail";
import { AbuseRepository } from "../repository";
import type { AbuseImapConfig, AbuseMailIngestResult, FetchedAbuseMail } from "./types";
import { isSeen, messageBody, normalizeMessageId, parseAbuseMail, recipients, references, headerStrings } from "./rfc";
import { routeSharedGnameCode } from "./routing";

type AbuseMailIngestConfig = Pick<AbuseImapConfig, "mailbox" | "processSeen"> & { uidValidity: number };

/**
 * Parse and persist one abuse-mail message without any dependency on the
 * legacy public-intake/case tables. Raw MIME and attachments are persisted by
 * persistInboundAbuseMail before the classifier or TOTP worker is queued.
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
		const route = (await AbuseRepository.findInboundRoute({ recipients: recipientAddresses, inReplyTo, references: references(parsed) }))
			?? await routeSharedGnameCode({ parsed, recipients: recipientAddresses, body });
		if (!route) return { disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" };

		const existingByMessageId = messageId ? await AbuseRepository.getInboundMailByMessageId(messageId) : undefined;
		if (existingByMessageId) return { disposition: "terminal", route: "reply", reason: "duplicate_message_id", messageId: existingByMessageId.id };
		const stored = await persistInboundAbuseMail({
			routeId: route.id,
			reportId: route.reportId,
			rawMime: raw,
			mailbox: config.mailbox,
			uidValidity: config.uidValidity,
			uid: message.uid,
		});
		if (!stored.created) return { disposition: "terminal", route: "reply", reason: "duplicate_imap_delivery", messageId: stored.messageId };
		await AbuseRepository.enqueueJob({
			jobType: "classify_provider_reply",
			reportId: route.reportId,
			routeId: route.id,
			payload: { messageId: stored.messageId.toString() },
			dedupeKey: `classify-abuse-mail:${stored.messageId.toString()}`,
		});
		const currentRoute = await AbuseRepository.getRoute(route.id);
		const code = extractUnambiguousVerificationCode(body);
		if (currentRoute?.status === "waiting_code" && code) {
			await AbuseRepository.enqueueJob({
				jobType: "send_totp_code",
				reportId: route.reportId,
				routeId: route.id,
				payload: { messageId: stored.messageId.toString(), totpIdentifier: currentRoute.serviceIdentity && typeof currentRoute.serviceIdentity.mailbox === "string" ? currentRoute.serviceIdentity.mailbox : undefined },
				dedupeKey: `send-totp:${route.id.toString()}:${stored.messageId.toString()}`,
			});
		}
		return { disposition: "terminal", route: "reply", reason: "stored_abuse_reply", messageId: stored.messageId };
	} catch (error) {
		return { disposition: "retry", reason: error instanceof Error ? error.message : String(error) };
	}
}
