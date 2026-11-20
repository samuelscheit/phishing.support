import nodemailer from "nodemailer";

import { normalizeMailbox } from "../abuse/mail/shared";
import type { DeliveryStatusRequest } from "../abuse/mail/types";
import { normalizeDomain } from "../abuse/security";

/**
 * The service owns one mail account: SMTP_FROM sends every report and reporter
 * notification, and the IMAP_MAILBOXES folders receive forwarded phishing mail
 * and provider replies. Server-side rules may file them into different folders.
 */

function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name]?.trim();
	return value ? ["1", "true", "yes"].includes(value.toLowerCase()) : fallback;
}

function envPort(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isSafeInteger(value) && value > 0 && value <= 65_535 ? value : fallback;
}

export type MailTransport = {
	sendMail(options: { raw: Buffer; envelope: { from: string; to: string[] }; dsn: DeliveryStatusRequest } | { from: string; to: string; subject: string; text: string; envelope: { from: string; to: string[] } }): Promise<{ messageId?: string }>;
};

let transport: MailTransport | null | undefined;

/** The configured SMTP transport, or undefined when SMTP is not configured. */
export function smtpTransport(): MailTransport | undefined {
	if (transport !== undefined) return transport ?? undefined;
	const host = process.env.SMTP_HOST?.trim();
	const user = process.env.SMTP_USER?.trim();
	const pass = process.env.SMTP_PASS;
	if (!host || !user || !pass) {
		transport = null;
		return undefined;
	}
	const port = envPort("SMTP_PORT", 587);
	transport = nodemailer.createTransport({ host, port, secure: envBool("SMTP_SECURE", port === 465), auth: { user, pass } });
	return transport;
}

/** The relay every report leaves through (`SMTP_HOST`), or undefined when SMTP is not configured. */
export function smtpRelay(): string | undefined {
	return process.env.SMTP_HOST?.trim().toLowerCase() || undefined;
}

/** The authenticated sender mailbox (`SMTP_FROM`, which may include a display name). */
export function smtpSender(): string {
	const configured = process.env.SMTP_FROM?.trim();
	if (!configured) throw new Error("SMTP_FROM must be configured.");
	const mailbox = normalizeMailbox(configured.match(/<([^<>]+)>/)?.[1] ?? configured);
	if (!mailbox) throw new Error("SMTP_FROM must contain one valid mailbox.");
	return mailbox;
}

/**
 * The envelope sender of every mail (`SMTP_RETURN_PATH`), where bounces go:
 * the relay's own bounce address, since the iCloud mailbox refuses the relay's
 * bounces (imap/maildir.ts). Defaults to SMTP_FROM.
 */
export function smtpReturnPath(): string {
	const configured = process.env.SMTP_RETURN_PATH?.trim();
	if (!configured) return smtpSender();
	const mailbox = normalizeMailbox(configured);
	if (!mailbox) throw new Error("SMTP_RETURN_PATH must be one valid mailbox.");
	return mailbox;
}

/** The Maildir the relay files bounces into (`RELAY_BOUNCE_MAILDIR`), or undefined. */
export function relayBounceMaildir(): string | undefined {
	return process.env.RELAY_BOUNCE_MAILDIR?.trim() || undefined;
}

/** Domain for generated Reply-To and Message-ID identities. It must deliver into one of IMAP_MAILBOXES. */
export function replyDomain(): string {
	const domain = normalizeDomain(process.env.REPLY_DOMAIN ?? "");
	if (!domain) throw new Error("REPLY_DOMAIN must be configured as a public domain.");
	return domain;
}

export type ImapConfig = {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	pass: string;
	/** Every watched folder; each message is routed the same way whichever folder holds it. */
	mailboxes: string[];
	/**
	 * Folders that also hold the account owner's own mail, such as INBOX, where a
	 * provider's reply lands when no server rule files it. Only mail addressed to
	 * REPLY_DOMAIN is read from them; everything else is never fetched.
	 */
	sharedMailboxes: string[];
	/** Address that receives forwarded phishing mail for analysis. */
	intakeAddress: string;
};

/** The monitored mailbox, or undefined when IMAP is not configured. */
export function imapConfig(): ImapConfig | undefined {
	const host = process.env.IMAP_HOST?.trim();
	const user = process.env.IMAP_USER?.trim();
	const pass = process.env.IMAP_PASS;
	const folders = (name: string) => [...new Set((process.env[name] ?? "").split(",").map((mailbox) => mailbox.trim()).filter(Boolean))];
	const mailboxes = folders("IMAP_MAILBOXES");
	const sharedMailboxes = folders("IMAP_SHARED_MAILBOXES").filter((mailbox) => !mailboxes.includes(mailbox));
	const intake = process.env.IMAP_LISTEN_ADDRESS?.trim();
	if (!host || !user || !pass || mailboxes.length === 0 || !intake) return undefined;
	const intakeAddress = normalizeMailbox(intake);
	if (!intakeAddress) throw new Error("IMAP_LISTEN_ADDRESS must be a valid mailbox.");
	if (intakeAddress.slice(intakeAddress.lastIndexOf("@") + 1) !== replyDomain()) {
		throw new Error("REPLY_DOMAIN must match the domain of IMAP_LISTEN_ADDRESS so provider replies reach the monitored mailbox.");
	}
	return { host, port: envPort("IMAP_PORT", 993), secure: envBool("IMAP_SECURE", true), user, pass, mailboxes, sharedMailboxes, intakeAddress };
}
