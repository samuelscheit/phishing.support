import { ImapFlow } from "imapflow";

import { imapConfig } from "../../../mail_config";
import { ERANET_PROVIDER } from "./definition";

const CODE = /verification code is:?\s*(\d{6})\b/i;
const POLL_MS = 5_000;

/** The six-digit code in one Eranet verification mail, from its decoded body. */
export function eranetCodeFromMail(params: { from: string; subject: string; body: string }): string | undefined {
	const domain = params.from.slice(params.from.lastIndexOf("@") + 1).toLowerCase();
	if (domain !== ERANET_PROVIDER.codeMail.senderDomain) return undefined;
	if (!params.subject.toLowerCase().includes(ERANET_PROVIDER.codeMail.subjectPattern)) return undefined;
	return CODE.exec(params.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))?.[1];
}

export type EranetCodeReader = (requestedAt: Date, signal?: AbortSignal) => Promise<string>;

/**
 * Wait for the code Eranet mails after `requestedAt`. The mailbox is opened
 * read-only and searched by sender and time, so the IMAP listener's own
 * bookkeeping is untouched; the newest matching code wins.
 */
export const readEranetCodeFromMailbox: EranetCodeReader = async (requestedAt, signal) => {
	const config = imapConfig();
	if (!config) throw new Error("Eranet reporting requires the IMAP mailbox to receive its verification code.");
	const deadline = Date.now() + ERANET_PROVIDER.codeMail.waitMs;
	const client = new ImapFlow({ host: config.host, port: config.port, secure: config.secure, auth: { user: config.user, pass: config.pass }, logger: false, disableAutoIdle: true });
	await client.connect();
	try {
		while (Date.now() < deadline) {
			signal?.throwIfAborted();
			for (const mailbox of config.mailboxes) {
				const lock = await client.getMailboxLock(mailbox, { readOnly: true });
				try {
					const uids = await client.search({ from: ERANET_PROVIDER.codeMail.senderDomain, since: new Date(requestedAt.getTime() - 60_000) }, { uid: true });
					let newest: { at: number; code: string } | undefined;
					for await (const message of client.fetch(uids || [], { envelope: true, source: true }, { uid: true })) {
						const at = message.envelope?.date ? new Date(message.envelope.date).getTime() : 0;
						if (at < requestedAt.getTime() - 5_000 || at > requestedAt.getTime() + ERANET_PROVIDER.codeMail.maxAgeMs) continue;
						const raw = message.source?.toString("utf8") ?? "";
						const body = raw.slice(raw.indexOf("\r\n\r\n"))
							.replace(/=\r\n/g, "")
							.replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
						const code = eranetCodeFromMail({
							from: message.envelope?.from?.[0]?.address ?? "",
							subject: message.envelope?.subject ?? "",
							body,
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
		throw new Error("Eranet's verification code did not arrive in time.");
	} finally {
		await client.logout().catch(() => undefined);
	}
};
