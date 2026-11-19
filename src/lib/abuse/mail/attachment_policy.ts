import { registrableDomain } from "../security";
import type { AbuseMailAttachment } from "./types";

/**
 * Mail servers that refuse a report carrying the phishing mail as an attached
 * message (.eml, message/rfc822). They get it as plain text from the start.
 * Add a domain when its server refused such an attachment
 * (`isAttachmentRefusal`).
 */
const REFUSE_ATTACHED_MESSAGES = new Set([
	// 2026-11-19: "550 Attached file 'phishing-email.eml' has disallowed extension".
	"hostzealot.com",
]);

export function refusesAttachedMessages(recipient: string): boolean {
	const domain = registrableDomain(recipient.slice(recipient.lastIndexOf("@") + 1));
	return domain !== undefined && REFUSE_ATTACHED_MESSAGES.has(domain);
}

/**
 * A rejection of the report's attachment, not of the mailbox: the server
 * names an attachment, file extension or file type as disallowed.
 */
export function isAttachmentRefusal(diagnostic: string): boolean {
	return /\b(?:attach(?:ed|ment)s?|file ?(?:name|type|extension)|extension)\b[^;\n]{0,100}?\b(?:disallowed|not (?:allowed|permitted|accepted)|prohibited|forbidden|blocked|banned|unacceptable)\b/i.test(diagnostic)
		|| /\b(?:disallowed|prohibited|forbidden|blocked|banned)\b[^;\n]{0,40}?\b(?:attach(?:ed|ment)s?|file ?(?:name|type|extension)|extension)\b/i.test(diagnostic);
}

function isAttachedMessage(attachment: AbuseMailAttachment): boolean {
	return attachment.mimeType.toLowerCase() === "message/rfc822" || attachment.filename.toLowerCase().endsWith(".eml");
}

/** The attached phishing mail as plain text: the same bytes as `<name>.txt`, text/plain. */
export function attachedMessagesAsText(attachments: AbuseMailAttachment[]): AbuseMailAttachment[] {
	return attachments.map((attachment) => isAttachedMessage(attachment) ? { ...attachment, filename: `${attachment.filename}.txt`, mimeType: "text/plain" } : attachment);
}
