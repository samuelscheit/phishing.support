import nodemailer from "nodemailer";

import { normalizeMailbox } from "./abuse/mail/shared";
import { normalizeDomain } from "./abuse/security";

/**
 * The service owns one mailbox: SMTP_FROM sends every report and reporter
 * notification, and IMAP_MAILBOX receives both forwarded phishing mail and
 * provider replies (to `abuse-<token>@REPLY_DOMAIN` Reply-To identities).
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
	sendMail(options: { raw: Buffer; envelope: { from: string; to: string[] } } | { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }>;
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

/** The authenticated sender mailbox (`SMTP_FROM`, which may include a display name). */
export function smtpSender(): string {
	const configured = process.env.SMTP_FROM?.trim();
	if (!configured) throw new Error("SMTP_FROM must be configured.");
	const mailbox = normalizeMailbox(configured.match(/<([^<>]+)>/)?.[1] ?? configured);
	if (!mailbox) throw new Error("SMTP_FROM must contain one valid mailbox.");
	return mailbox;
}

/** Domain for generated Reply-To and Message-ID identities. It must deliver into IMAP_MAILBOX. */
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
	mailbox: string;
	/** Address that receives forwarded phishing mail for analysis. */
	intakeAddress: string;
};

/** The monitored mailbox, or undefined when IMAP is not configured. */
export function imapConfig(): ImapConfig | undefined {
	const host = process.env.IMAP_HOST?.trim();
	const user = process.env.IMAP_USER?.trim();
	const pass = process.env.IMAP_PASS;
	const mailbox = process.env.IMAP_MAILBOX?.trim();
	const intake = process.env.IMAP_LISTEN_ADDRESS?.trim();
	if (!host || !user || !pass || !mailbox || !intake) return undefined;
	const intakeAddress = normalizeMailbox(intake);
	if (!intakeAddress) throw new Error("IMAP_LISTEN_ADDRESS must be a valid mailbox.");
	if (intakeAddress.slice(intakeAddress.lastIndexOf("@") + 1) !== replyDomain()) {
		throw new Error("REPLY_DOMAIN must match the domain of IMAP_LISTEN_ADDRESS so provider replies reach the monitored mailbox.");
	}
	return { host, port: envPort("IMAP_PORT", 993), secure: envBool("IMAP_SECURE", true), user, pass, mailbox, intakeAddress };
}
