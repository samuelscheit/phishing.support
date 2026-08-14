import { simpleParser, type ParsedMail } from "mailparser";

import { AbuseRepository } from "../repository";
import { attachmentFilename, inboundBodyText, isRfcMessageId } from "./shared";

/** Parse and retain raw inbound MIME plus attachments before any classification. */
export async function persistInboundAbuseMail(params: {
	routeId: bigint;
	reportId: bigint;
	rawMime: Buffer;
	mailbox: string;
	uidValidity: number;
	uid: number;
}): Promise<{ messageId: bigint; created: boolean }> {
	const parsed = await simpleParser(params.rawMime);
	const route = await AbuseRepository.getRoute(params.routeId);
	if (!route) throw new Error("Inbound abuse mail route no longer exists.");
	const addressList = (value: ParsedMail["to"]): string[] => {
		if (!value) return [];
		const entries = Array.isArray(value) ? value.flatMap((item) => item.value) : value.value;
		return entries.map((entry) => entry.address).filter((entry): entry is string => Boolean(entry));
	};
	const from = addressList(parsed.from).join(", ") || undefined;
	const to = addressList(parsed.to);
	const stored = await AbuseRepository.persistInboundMailWithArtifacts({
		reportId: params.reportId,
		routeId: params.routeId,
		kind: "reply",
		fromAddress: from,
		toAddresses: to ?? [],
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
