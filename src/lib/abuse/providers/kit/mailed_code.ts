import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";

import { imapConfig, type ImapConfig } from "../../../mail/config";
import { sleep as realSleep, type Sleep } from "../../../util/sleep";

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
	/** Where the code stands: the body (default) or the subject ("Your one-time verification key is TPSD5P"). */
	codeSource?: "subject";
	/** A mail older than this after the request is not its answer. */
	maxAgeMs: number;
	/** How long the reader waits for the mail. */
	waitMs: number;
};

export type MailedCodeReader = (requestedAt: Date, signal?: AbortSignal) => Promise<string>;

const POLL_MS = 5_000;

function senderMatches(spec: MailedCodeSpec, from: string): boolean {
	const separator = from.lastIndexOf("@");
	if (separator < 0) return false;
	const domain = from.slice(separator + 1).toLowerCase();
	return spec.senderDomains.some((sender) => domain === sender || domain.endsWith(`.${sender}`));
}

/** The code in one decoded mail, if it is the provider's verification mail. */
export function mailedCodeFrom(spec: MailedCodeSpec, mail: { from: string; subject: string; body: string }): string | undefined {
	if (!senderMatches(spec, mail.from)) return undefined;
	if (!mail.subject.toLowerCase().includes(spec.subjectPattern)) return undefined;
	const text = (spec.codeSource === "subject" ? mail.subject : mail.body).replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
	return new RegExp(spec.codePattern, "i").exec(text)?.[1];
}

/**
 * The mailbox settings, the connection and the pause between polls; tests pass fakes instead of
 * mocking modules or changing the process environment, which work another test file left running
 * can change under them.
 */
export type MailedCodeIo = {
	config?: () => ImapConfig | undefined;
	imap?: (options: ImapFlowOptions) => Pick<ImapFlow, "connect" | "getMailboxLock" | "search" | "fetch" | "logout">;
	sleep?: Sleep;
};

/**
 * Wait for the code the provider mails after `requestedAt`. The mailbox is
 * opened read-only and searched by time only, so the IMAP listener's own
 * bookkeeping is untouched; the newest matching code wins. The sender is
 * matched here, from the envelope: iCloud's IMAP FROM search matches only a
 * sender's full host, so a code from a subdomain (Alibaba Cloud's
 * system-sg@notice.alibabacloud.com) was never found by a search for its domain.
 */
export function mailedCodeReader(spec: MailedCodeSpec, io: MailedCodeIo = {}): MailedCodeReader {
	const openImap = io.imap ?? ((options) => new ImapFlow(options));
	const sleep = io.sleep ?? realSleep;
	const mailbox = io.config ?? imapConfig;
	return async (requestedAt, signal) => {
		const config = mailbox();
		if (!config) throw new Error(`${spec.provider} reporting requires the IMAP mailbox to receive its verification code.`);
		const deadline = Date.now() + spec.waitMs;
		const client = openImap({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: config.pass }, logger: false, disableAutoIdle: true });
		await client.connect();
		// Per mailbox, the highest UID already read: each poll after the first reads only newer mail.
		const seen = new Map<string, number>();
		try {
			while (Date.now() < deadline) {
				signal?.throwIfAborted();
				// A code mail no server rule filed stays in a shared folder; the search by sender reads nothing else there.
				for (const mailbox of [...config.mailboxes, ...config.sharedMailboxes]) {
					const lock = await client.getMailboxLock(mailbox, { readOnly: true });
					try {
						const last = seen.get(mailbox);
						const found = await client.search(last === undefined ? { since: new Date(requestedAt.getTime() - 60_000) } : { uid: `${last + 1}:*` }, { uid: true });
						// "n:*" always matches the newest message, even one already read.
						const uids = (found || []).filter((uid) => last === undefined || uid > last);
						if (uids.length > 0) seen.set(mailbox, Math.max(last ?? 0, ...uids));
						else if (last === undefined) seen.set(mailbox, 0);
						const candidates: number[] = [];
						if (uids.length > 0) for await (const message of client.fetch(uids, { envelope: true }, { uid: true })) {
							const at = message.envelope?.date ? new Date(message.envelope.date).getTime() : 0;
							if (at < requestedAt.getTime() - 5_000 || at > requestedAt.getTime() + spec.maxAgeMs) continue;
							if (senderMatches(spec, message.envelope?.from?.[0]?.address ?? "")) candidates.push(message.uid);
						}
						let newest: { at: number; code: string } | undefined;
						if (candidates.length > 0) for await (const message of client.fetch(candidates, { envelope: true, source: true }, { uid: true })) {
							const at = message.envelope?.date ? new Date(message.envelope.date).getTime() : 0;
							if (!message.source) continue;
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
				await sleep(POLL_MS);
			}
			throw new Error(`${spec.provider}'s verification code did not arrive in time.`);
		} finally {
			await client.logout().catch(() => undefined);
		}
	};
}
