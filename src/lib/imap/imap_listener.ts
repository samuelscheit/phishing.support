import { type FetchMessageObject, ImapFlow } from "imapflow";
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";

import { ingestFetchedIncomingMail } from "@/lib/imap/ingest";
import { getReportReplyDomain, normalizeEmailAddress, validateReplyDomainForIntake } from "@/lib/report/correspondence";
import { retry } from "../utils";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
}

function envBool(name: string, defaultValue: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined) return defaultValue;
	return raw === "true" || raw === "1" || raw === "yes";
}

function envInt(name: string, defaultValue: number): number {
	const raw = process.env[name];
	if (!raw) return defaultValue;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : defaultValue;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type ListenerConfig = {
	listenAddress: string;
	host: string;
	port: number;
	secure: boolean;
	user: string;
	pass: string;
	mailbox: string;
	processSeen: boolean;
};

function getListenerConfig(): ListenerConfig {
	const listenAddress = normalizeEmailAddress(requiredEnv("IMAP_LISTEN_ADDRESS"));
	if (!listenAddress) throw new Error("IMAP_LISTEN_ADDRESS must be a valid mailbox address.");
	validateReplyDomainForIntake(getReportReplyDomain(), listenAddress);

	return {
		listenAddress,
		host: requiredEnv("IMAP_HOST"),
		port: envInt("IMAP_PORT", 993),
		secure: envBool("IMAP_SECURE", true),
		user: requiredEnv("IMAP_USER"),
		pass: requiredEnv("IMAP_PASS"),
		mailbox: requiredEnv("IMAP_MAILBOX"),
		processSeen: envBool("IMAP_PROCESS_SEEN", false),
	};
}

function createImapClient(config: ListenerConfig): ImapFlow {
	return new ImapFlow({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: { user: config.user, pass: config.pass },
		// The listener owns the explicit idle()/fetch loop below. Leaving
		// IMAPFlow auto-IDLE enabled can make idle() return immediately when an
		// automatic IDLE is already active, resulting in a busy loop.
		disableAutoIdle: true,
	});
}

function isNoConnectionError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "NoConnection");
}

/**
 * The IMAP client is intentionally limited to fetching and marking messages.
 * All routing, parsing, persistence, and idempotency lives in ingest.ts so it
 * can be exercised with deterministic RFC 5322 fixtures without a mailbox.
 */
export async function startImapListener() {
	loadDotenv({ path: join(process.cwd(), ".env"), quiet: true });
	const config = getListenerConfig();

	let stopped = false;
	let activeClient: ImapFlow | null = null;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		console.log("Stopping IMAP listener...");
		try {
			activeClient?.close();
		} catch {
			// The connection may already be closed during shutdown.
		}
	};

	try {
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);

		while (!stopped) {
			const client = createImapClient(config);
			activeClient = client;
			try {
				console.log("Connecting to IMAP server...");
				await retry(() => client.connect());
				const lock = await client.getMailboxLock(config.mailbox);

				try {
					const mailboxExists = () => (client.mailbox && typeof client.mailbox === "object" ? (client.mailbox.exists ?? 0) : 0);
					const mailboxUidValidity = () => Number(client.mailbox && typeof client.mailbox === "object" ? (client.mailbox.uidValidity ?? 0) : 0);
					const markSeen = async (uid: number, reason: string) => {
						try {
							await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
						} catch (error) {
							console.error(`Failed to mark IMAP message ${uid} as seen (${reason}):`, error);
						}
					};

					const processMailbox = async (reason: string) => {
						console.log(`Processing ${reason} IMAP messages in ${config.mailbox}...`);
						// UID 1:* is deliberate: providers or users may mark a reply read
						// before us. The terminal ledger makes the scan idempotent. IMAPFlow
						// forbids commands inside its fetch iterator, so Seen changes wait.
						const seenAfterFetch = new Map<number, string>();
						for await (const message of client.fetch("1:*", {
							uid: true,
							source: true,
							flags: true,
							envelope: true,
							internalDate: true,
						})) {
							const fetched = message as FetchMessageObject;
							if (!fetched.uid) continue;
							const result = await ingestFetchedIncomingMail(fetched, {
								mailbox: config.mailbox,
								uidValidity: mailboxUidValidity(),
								intakeAddress: config.listenAddress,
								processSeen: config.processSeen,
							});
							if (result.disposition === "terminal") seenAfterFetch.set(fetched.uid, result.reason);
						}
						for (const [uid, seenReason] of seenAfterFetch) await markSeen(uid, seenReason);
					};

					let processingMailbox: Promise<void> | undefined;
					let processingRequested = false;
					let processingReason = "new";
					const requestMailboxProcessing = (reason: string) => {
						processingRequested = true;
						processingReason = reason;
						if (processingMailbox) return processingMailbox;

						processingMailbox = (async () => {
							while (processingRequested && !stopped) {
								processingRequested = false;
								await processMailbox(processingReason);
							}
						})().finally(() => {
							processingMailbox = undefined;
						});
						return processingMailbox;
					};

					const onExists = () => {
						// IMAP IDLE delivers EXISTS as an event but does not end the idle
						// promise. Starting FETCH breaks IDLE through IMAPFlow's pre-check,
						// so this handler gives new replies prompt, serialized processing.
						requestMailboxProcessing("new").catch((error) => {
							if (!stopped) console.error("Failed to process newly arrived IMAP mail:", error);
						});
					};
					client.on("exists", onExists);
					try {
						// Subscribe before the initial all-message scan. If a reply arrives
						// while it is running, the queued follow-up scan cannot miss it.
						await requestMailboxProcessing("existing");
						let lastExists = mailboxExists();
						while (!stopped) {
							// FETCH breaks the current IDLE session. Do not start another IDLE
							// until the serialized fetch/ingest pass has completed, otherwise
							// concurrent IMAP commands can race on the single connection.
							if (processingMailbox) await processingMailbox;
							try {
								await client.idle();
							} catch (error) {
								if (stopped) break;
								if (isNoConnectionError(error)) console.warn("IMAP connection lost during IDLE, reconnecting...");
								else console.error("IMAP idle error, reconnecting session:", error);
								throw error;
							}

							const currentExists = mailboxExists();
							if (currentExists !== lastExists) requestMailboxProcessing("idle wakeup");
							lastExists = currentExists;
						}
					} finally {
						client.off("exists", onExists);
						await processingMailbox;
					}
				} finally {
					try {
						lock.release();
					} catch {
						// Ignore lock cleanup after an interrupted connection.
					}
				}
			} catch (error) {
				if (stopped) break;
				if (!isNoConnectionError(error)) console.error("IMAP listener session error:", error);
				await sleep(2_000);
			} finally {
				activeClient = null;
				try {
					client.close();
				} catch {
					// Connection may already be closed.
				}
			}
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		console.log("IMAP listener stopped.");
	}
}
