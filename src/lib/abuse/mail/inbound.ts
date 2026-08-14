import { simpleParser, type ParsedMail } from "mailparser";

import { AbuseRepository } from "../repository";
import { attachmentFilename, inboundBodyText, isRfcMessageId } from "./shared";

/** Parse and retain raw inbound MIME plus attachments before any classification. */
export async function persistInboundAbuseMail(params: {
	routeId: bigint;
	reportId: bigint;
	/** Canonical delivery recipients from IMAP headers and envelope metadata. */
	recipientAddresses: string[];
	rawMime: Buffer;
	mailbox: string;
	uidValidity: number;
	uid: number;
}): Promise<{ messageId: bigint; created: boolean }> {
	const parsed = await simpleParser(params.rawMime);
	const addressList = (value: ParsedMail["to"]): string[] => {
		if (!value) return [];
		const entries = Array.isArray(value) ? value.flatMap((item) => item.value) : value.value;
		return entries.map((entry) => entry.address).filter((entry): entry is string => Boolean(entry));
	};
	const from = addressList(parsed.from).join(", ") || undefined;
	const stored = await AbuseRepository.persistInboundMailWithArtifacts({
		reportId: params.reportId,
		routeId: params.routeId,
		kind: "reply",
		fromAddress: from,
		// IMAP ingestion selected the route from this complete canonical set,
		// including envelope and delivery-recipient fields that may not occur in
		// the visible RFC To header. Retain the same evidence for a provider's
		// post-storage authorization check.
		toAddresses: [...new Set(params.recipientAddresses)],
		subject: parsed.subject,
		textBody: inboundBodyText(parsed),
		messageId: isRfcMessageId(parsed.messageId) ? parsed.messageId : undefined,
		inReplyTo: parsed.inReplyTo,
		references: typeof parsed.references === "string" ? [parsed.references] : parsed.references,
		mailbox: params.mailbox,
		uidValidity: params.uidValidity,
		uid: params.uid,
		rawMime: {
			name: `inbound-${params.uid}.eml`,
			buffer: params.rawMime,
			metadata: { uid: params.uid, uidValidity: params.uidValidity, mailbox: params.mailbox },
		},
		attachments: parsed.attachments.map((attachment, index) => ({
			name: attachmentFilename(attachment.filename ?? `attachment-${index + 1}`),
			mimeType: attachment.contentType,
			buffer: attachment.content,
		})),
		occurredAt: parsed.date ?? new Date(),
	});
	return { messageId: stored.id, created: stored.created };
}
