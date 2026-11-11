import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import { imapConfig } from "../../mail_config";

/**
 * The verification-code mail a provider's form sends before it accepts a
 * report: who sends it, what its subject says, and the pattern whose first
 * group is the code. Plain data, so it is part of the provider's pinned
 * definition hash.
 */
export type MailedCodeSpec = {
	/** Named in errors: "Eranet", "GNAME". */
	provider: string;
	/** The domains the provider sends from; a subdomain of one is the same sender. */
	senderDomains: readonly string[];
	/** Lower-case text the subject must contain. */
	subjectPattern: string;
	/** A regular expression source; group 1 is the code. Matched case-insensitively against the text with tags and runs of white space collapsed. */
	codePattern: string;
	/** A mail older than this after the request is not its answer. */
	maxAgeMs: number;
	/** How long the reader waits for the mail. */
	waitMs: number;
};

export type MailedCodeReader = (requestedAt: Date, signal?: AbortSignal) => Promise<string>;

const POLL_MS = 5_000;

function senderMatches(spec: MailedCodeSpec, from: string): boolean {
	const domain = from.slice(from.lastIndexOf("@") + 1).toLowerCase();
	return spec.senderDomains.some((sender) => domain === sender || domain.endsWith(`.${sender}`));
}

/** The code in one decoded mail, if it is the provider's verification mail. */
export function mailedCodeFrom(spec: MailedCodeSpec, mail: { from: string; subject: string; body: string }): string | undefined {
	if (!senderMatches(spec, mail.from)) return undefined;
	if (!mail.subject.toLowerCase().includes(spec.subjectPattern)) return undefined;
	const text = mail.body.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
	return new RegExp(spec.codePattern, "i").exec(text)?.[1];
}

/**
 * Wait for the code the provider mails after `requestedAt`. The mailbox is
 * opened read-only and searched by sender and time, so the IMAP listener's
 * own bookkeeping is untouched; the newest matching code wins.
 */
export function mailedCodeReader(spec: MailedCodeSpec): MailedCodeReader {
	return async (requestedAt, signal) => {
		const config = imapConfig();
		if (!config) throw new Error(`${spec.provider} reporting requires the IMAP mailbox to receive its verification code.`);
		const deadline = Date.now() + spec.waitMs;
		const client = new ImapFlow({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: config.pass }, logger: false, disableAutoIdle: true });
		await client.connect();
		try {
			while (Date.now() < deadline) {
				signal?.throwIfAborted();
				for (const mailbox of config.mailboxes) {
					const lock = await client.getMailboxLock(mailbox, { readOnly: true });
					try {
						const since = new Date(requestedAt.getTime() - 60_000);
						const uids = await client.search(spec.senderDomains.length === 1
							? { from: spec.senderDomains[0], since }
							: { since, or: spec.senderDomains.map((domain) => ({ from: domain })) }, { uid: true });
						let newest: { at: number; code: string } | undefined;
						for await (const message of client.fetch(uids || [], { envelope: true, source: true }, { uid: true })) {
							const at = message.envelope?.date ? new Date(message.envelope.date).getTime() : 0;
							if (at < requestedAt.getTime() - 5_000 || at > requestedAt.getTime() + spec.maxAgeMs || !message.source) continue;
							const parsed = await simpleParser(message.source);
							const code = mailedCodeFrom(spec, {
								from: message.envelope?.from?.[0]?.address ?? "",
								subject: message.envelope?.subject ?? "",
								body: typeof parsed.html === "string" && parsed.html ? parsed.html : parsed.text ?? "",
							});
							if (code && (!newest || at > newest.at)) newest = { at, code };
						}
						if (newest) return newest.code;
					} finally {
						lock.release();
					}
				}
				await new Promise((resolve) => setTimeout(resolve, POLL_MS));
			}
			throw new Error(`${spec.provider}'s verification code did not arrive in time.`);
		} finally {
			await client.logout().catch(() => undefined);
		}
	};
}
