import { ImapFlow, type FetchMessageObject } from "imapflow";

import { imapConfig, type ImapConfig } from "../mail_config";
import { ingestFetchedMail } from "./ingest";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function noConnection(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "NoConnection");
}

/**
 * The client only fetches and marks messages. Routing, parsing, persistence,
 * and idempotency live in `ingest.ts` so they run against deterministic
 * RFC 5322 fixtures in tests.
 */
export class MailboxListener {
	private stopped = true;
	private loopPromise: Promise<void> | undefined;
	private activeClient: ImapFlow | undefined;

	constructor(private readonly config: ImapConfig) {}

	start(): void {
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
				// This loop owns idle()/fetch. IMAPFlow auto-IDLE would make idle()
				// return immediately and busy-loop.
				disableAutoIdle: true,
				logger: false,
			});
			this.activeClient = client;
			try {
				await client.connect();
				const lock = await client.getMailboxLock(this.config.mailbox);
				try {
					const uidValidity = Number(typeof client.mailbox === "object" && client.mailbox ? client.mailbox.uidValidity ?? 0 : 0);
					if (!Number.isSafeInteger(uidValidity) || uidValidity <= 0) throw new Error("IMAP mailbox did not expose a valid UIDVALIDITY.");
					const processMailbox = async () => {
						// UID 1:* is deliberate: a provider reply may already be marked
						// read. The terminal ledger makes the scan idempotent. IMAPFlow
						// forbids commands inside its fetch iterator, so flags wait.
						const seen = new Set<number>();
						for await (const fetched of client.fetch("1:*", { uid: true, source: true, flags: true, envelope: true, internalDate: true })) {
							const message = fetched as FetchMessageObject;
							if (!message.uid) continue;
							const result = await ingestFetchedMail(message, { mailbox: this.config.mailbox, uidValidity, intakeAddress: this.config.intakeAddress });
							if (result.disposition === "terminal") seen.add(message.uid);
							else if (result.disposition === "retry") console.error(`IMAP message ${message.uid} will be retried: ${result.reason}`);
						}
						for (const uid of seen) {
							try {
								await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
							} catch (error) {
								console.error(`Failed to mark IMAP UID ${uid} as seen:`, error);
							}
						}
					};

					let requested = false;
					let processing: Promise<void> | undefined;
					const requestProcessing = () => {
						requested = true;
						processing ??= (async () => {
							while (requested && !this.stopped) {
								requested = false;
								await processMailbox();
							}
						})().finally(() => {
							processing = undefined;
						});
						return processing;
					};
					// IDLE delivers EXISTS as an event without ending idle(). Starting
					// a FETCH breaks IDLE, so new mail is processed promptly and serially.
					const onExists = () => {
						void requestProcessing().catch((error) => {
							if (!this.stopped) console.error("IMAP processing failed:", error);
						});
					};
					// Subscribe before the initial scan so mail arriving during it is not missed.
					client.on("exists", onExists);
					try {
						await requestProcessing();
						while (!this.stopped) {
							if (processing) await processing;
							await client.idle();
						}
					} finally {
						client.off("exists", onExists);
						await processing;
					}
				} finally {
					lock.release();
				}
			} catch (error) {
				if (!this.stopped && !noConnection(error)) console.error("IMAP listener session error:", error);
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

let singleton: MailboxListener | undefined;

/** Start the mailbox listener when IMAP is configured; returns whether it started. */
export function startMailboxListener(): boolean {
	const config = imapConfig();
	if (!config) return false;
	singleton ??= new MailboxListener(config);
	singleton.start();
	return true;
}

export async function stopMailboxListener(): Promise<void> {
	await singleton?.stop();
	singleton = undefined;
}
