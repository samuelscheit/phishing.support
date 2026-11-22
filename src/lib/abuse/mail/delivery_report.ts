import type { ParsedMail } from "mailparser";

import { serviceIdentity } from "../../network/service_identity";
import { flattenAddresses, headerStrings } from "../../imap/rfc";
import { normalizeMailbox } from "./shared";

/**
 * Whether a mail server will ever take the report. A temporary failure is
 * retried with the same mailbox; a permanent one moves on to the target's
 * next abuse contact.
 */
export type DeliveryOutcome = "permanent" | "temporary";

/** Subjects of the delivery reports that carry no machine-readable marker (Exchange 2003, Courier, OpenSMTPD). */
const FAILURE_SUBJECT = /undeliver|delivery (?:status|fail|problem|incomplete|has failed)|mail delivery|returned (?:mail|to sender)|returning message|failure notice|non[- ]?delivery|non remis|non recapitabile|unzustellbar/i;

/**
 * A delivery report (RFC 3464 DSN, or an MTA's own plain-text bounce) for
 * mail we sent: the Message-IDs of the returned mail, which we generated and
 * which bind it to exactly one route.
 */
export function deliveryFailure(parsed: ParsedMail): { messageIds: string[] } | undefined {
	if (!isDeliveryReport(parsed)) return undefined;
	const returned = parsed.attachments
		.filter((attachment) => /^(?:message\/rfc822|text\/rfc822-headers|message\/rfc822-headers)$/i.test(attachment.contentType))
		.map((attachment) => attachment.content.toString("utf8"))
		.join("\n");
	const text = `${parsed.text ?? ""}\n${returned}`;
	const ownDomain = new URL(serviceIdentity.url).hostname.replace(/[.]/g, "\\.");
	return { messageIds: [...new Set([...text.matchAll(new RegExp(`<[^<>\\s@]+@${ownDomain}>`, "gi"))].map((match) => match[0]!.toLowerCase()))] };
}

function isDeliveryReport(parsed: ParsedMail): boolean {
	if (headerStrings(parsed, "content-type").join(" ").toLowerCase().includes("report-type=delivery-status")) return true;
	// Exim marks every bounce it writes, Exchange every non-delivery report.
	// Exchange writes its marker without a value, which only the raw header lines keep.
	if (headerStrings(parsed, "x-failed-recipients").length || headerStrings(parsed, "x-ms-exchange-message-is-ndr").length) return true;
	const sender = flattenAddresses(parsed.from).map((entry) => normalizeMailbox(entry.address))[0] ?? "";
	if (/^mailer-daemon@/.test(sender)) return true;
	// A postmaster mailbox or an auto-reply may be a person or an out-of-office
	// notice: only a failure subject makes it a delivery report.
	const automated = /^postmaster@/.test(sender) || headerStrings(parsed, "auto-submitted").join(" ").toLowerCase().startsWith("auto-replied");
	return automated && FAILURE_SUBJECT.test(parsed.subject ?? "");
}

/** Every field of an RFC 3464 per-message or per-recipient block: where a flattened Diagnostic-Code ends. */
const DSN_FIELD = "(?:Reporting-MTA|Received-From-MTA|Arrival-Date|Original-Recipient|Final-Recipient|Action|Status|Remote-MTA|Diagnostic-Code|Last-Attempt-Date|Will-Retry-Until|X-[A-Za-z-]+)";
const DIAGNOSTIC = new RegExp(`\\bDiagnostic-Code:\\s*(.+?)(?=\\s${DSN_FIELD}:|$)`, "i");
/** What the MTAs that state it say about a failure without a Status field (Exim, qmail, Gmail's old format). */
const PERMANENT_STATEMENT = /\b(?:permanent (?:error|failure)|failed permanently|fatal errors?|not going to try again)\b/i;
const TEMPORARY_STATEMENT = /\b(?:temporary (?:error|failure)|warning message only|delivery attempts will continue|not yet been delivered|will be retried|has been delayed|is delayed|still trying)\b/i;
/** An enhanced status code (RFC 3463: subject 0 to 7) anywhere, but not part of an IP address or a version number such as Exim 4.94.2. */
const ENHANCED_CODE = /(?<![\d.])([45])\.[0-7]\.\d{1,3}(?![\d.])/;
/** An SMTP reply code a hop quoted: "said: 550", "error ... 450". */
const SMTP_CODE = /\b(?:said|error|returned|reply)\b[^.]{0,80}?\b([45])\d\d\b/i;

/**
 * What a delivery report says about the report's delivery, read from its
 * stored text (whitespace flattened or not). Per-recipient Status fields
 * decide; a report with a permanent failure for any recipient is permanent,
 * because a resend would fail there again. Without them, the MTA's own
 * statement decides, then the first status or reply code it quotes. A report
 * that says nothing is a failure: we ask relays for failure notices only
 * (DSN NOTIFY=FAILURE), never for delays.
 */
export function deliveryReport(text: string): { outcome: DeliveryOutcome; diagnostic?: string } {
	const flat = text.replace(/\s+/g, " ");
	const diagnostic = flat.match(DIAGNOSTIC)?.[1]?.trim().slice(0, 1_000);
	return { outcome: deliveryOutcome(flat), ...(diagnostic ? { diagnostic } : {}) };
}

function deliveryOutcome(text: string): DeliveryOutcome {
	const statuses = [...text.matchAll(/\bStatus:\s*([245])\.\d{1,3}\.\d{1,3}\b/gi)].map((match) => match[1]);
	if (statuses.includes("5")) return "permanent";
	if (statuses.includes("4")) return "temporary";
	if (PERMANENT_STATEMENT.test(text)) return "permanent";
	if (TEMPORARY_STATEMENT.test(text)) return "temporary";
	const code = text.match(ENHANCED_CODE)?.[1] ?? text.match(SMTP_CODE)?.[1];
	return code === "4" ? "temporary" : "permanent";
}
