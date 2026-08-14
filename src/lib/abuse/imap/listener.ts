import { ImapFlow, type FetchMessageObject } from "imapflow";

import { ingestFetchedAbuseMail } from "./ingest";
import { getAbuseImapConfig } from "./config";
import type { AbuseImapConfig } from "./types";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function noConnection(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "NoConnection");
}

export class AbuseImapListener {
	private stopped = true;
	private loopPromise: Promise<void> | undefined;
	private activeClient: ImapFlow | undefined;

	constructor(private readonly config: AbuseImapConfig) {}

	async start(): Promise<void> {
		if (!this.stopped) return;
		this.stopped = false;
		this.loopPromise = this.runLoop();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		try {
			await this.activeClient?.close();
		} catch {
			// The connection may already be closed during shutdown.
		}
		await this.loopPromise;
		this.loopPromise = undefined;
	}

	private async runLoop(): Promise<void> {
		while (!this.stopped) {
			const client = new ImapFlow({
				host: this.config.host,
				port: this.config.port,
				secure: this.config.secure,
				auth: { user: this.config.user, pass: this.config.pass },
				disableAutoIdle: true,
			});
			this.activeClient = client;
			try {
				await client.connect();
				const lock = await client.getMailboxLock(this.config.mailbox);
				try {
					const mailboxUidValidity = Number(typeof client.mailbox === "object" && client.mailbox ? client.mailbox.uidValidity ?? 0 : 0);
					if (!Number.isSafeInteger(mailboxUidValidity) || mailboxUidValidity <= 0) {
						throw new Error("Abuse IMAP mailbox did not expose a valid UIDVALIDITY.");
					}
					const processMailbox = async () => {
						const seen = new Set<number>();
						const searched = await client.search({ all: true }, { uid: true });
						const uids = searched === false ? [] : searched;
						for await (const fetched of client.fetch(uids, { source: true, flags: true, envelope: true, internalDate: true }, { uid: true })) {
							const message = fetched as FetchMessageObject;
							if (!message.uid) continue;
							const result = await ingestFetchedAbuseMail(message, { mailbox: this.config.mailbox, processSeen: this.config.processSeen, uidValidity: mailboxUidValidity });
							if (result.disposition === "terminal") seen.add(message.uid);
						}
						for (const uid of seen) {
							try {
								await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
							} catch (error) {
								console.error(`Failed to mark abuse IMAP UID ${uid} as seen:`, error);
							}
						}
					};
					await processMailbox();
					let requested = false;
					let processing: Promise<void> | undefined;
					const requestProcessing = () => {
						requested = true;
						if (processing) return;
						processing = (async () => {
							while (requested && !this.stopped) {
								requested = false;
								await processMailbox();
							}
						})().finally(() => {
							processing = undefined;
						});
						return processing;
					};
					const onExists = () => {
						void requestProcessing()?.catch((error) => console.error("Abuse IMAP processing failed:", error));
					};
					client.on("exists", onExists);
					while (!this.stopped) {
						if (processing) await processing;
						await client.idle();
						if (client.mailbox && typeof client.mailbox === "object" && Number(client.mailbox.exists ?? 0) > 0) requestProcessing();
					}
					client.off("exists", onExists);
					if (processing) await processing;
				} finally {
					lock.release();
				}
			} catch (error) {
				if (!this.stopped && !noConnection(error)) console.error("Abuse IMAP listener session error:", error);
				if (!this.stopped) await sleep(2_000);
			} finally {
				this.activeClient = undefined;
				try {
					await client.close();
				} catch {
					// Ignore close errors while reconnecting.
				}
			}
		}
	}
}

let singleton: AbuseImapListener | undefined;

export async function startAbuseImapListener(): Promise<AbuseImapListener | undefined> {
	const config = getAbuseImapConfig();
	if (!config) return undefined;
	singleton ??= new AbuseImapListener(config);
	await singleton.start();
	return singleton;
}

export async function stopAbuseImapListener(): Promise<void> {
	await singleton?.stop();
	singleton = undefined;
}
