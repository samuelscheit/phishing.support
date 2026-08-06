import { FetchMessageObject, ImapFlow } from "imapflow";
import { config as loadDotenv } from "dotenv";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

import { SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { join } from "node:path";
import { createEmailSubmissionFromEml } from "../submissions/email";
import { extractEmlsFromIncomingMessage } from "../mail_forwarded";
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
	if (!Number.isFinite(value)) return defaultValue;
	return value;
}

function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
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
	return {
		listenAddress: requiredEnv("IMAP_LISTEN_ADDRESS"),
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
		auth: {
			user: config.user,
			pass: config.pass,
		},
	});
}

function isNoConnectionError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	return "code" in err && (err as { code?: string }).code === "NoConnection";
}

function addressObjectIncludes(obj: AddressObject | AddressObject[] | undefined, address: string): boolean {
	if (!obj) return false;
	const needle = normalizeAddress(address);
	const list = Array.isArray(obj) ? obj : [obj];

	for (const entry of list) {
		for (const v of entry.value ?? []) {
			if (!v.address) continue;
			if (normalizeAddress(v.address) === needle) return true;
		}
	}

	return false;
}

export async function startImapListener() {
	// Load .env for standalone execution (Next.js loads env differently depending on runtime)
	loadDotenv({
		path: join(process.cwd(), ".env"),
		quiet: true,
	});

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
			// ignore
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
					const mailboxUidValidity = () =>
						client.mailbox && typeof client.mailbox === "object" ? (client.mailbox.uidValidity ?? 0) : 0;

					const mailboxKey = encodeURIComponent(config.mailbox);
					const makeImapSourcePrefix = (uid: number) => `imap:${mailboxKey}:${mailboxUidValidity()}:${uid}`;

					const processFetchedMessage = async (msg: FetchMessageObject) => {
						try {
							if (!msg?.uid) return;
							console.log(`Processing IMAP message UID ${msg.uid}...`, msg.flags);
							if (!config.processSeen && msg.flags?.has("\\Seen")) return;

							const sourcePrefix = makeImapSourcePrefix(msg.uid);
							const existingSubmissionId = await SubmissionsEntity.findIdBySourcePrefix(sourcePrefix);
							if (existingSubmissionId) {
								console.log(
									`Skipping IMAP UID ${msg.uid} (${sourcePrefix}): already has submission ${existingSubmissionId.toString()}`
								);
								try {
									await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
								} catch (e) {
									console.error("Failed to mark IMAP message as seen (skip):", e);
								}
								return;
							}

							const raw = msg.source?.toString("utf-8") ?? "";
							if (!raw.trim()) return;

							let parsed: ParsedMail;
							try {
								parsed = await simpleParser(raw, { skipTextToHtml: true });
							} catch (err) {
								await SubmissionsEntity.create({
									kind: "email",
									data: { kind: "email" },
									dedupeKey: sourcePrefix,
									id: generateId(),
									source: sourcePrefix,
									status: "failed",
									info: `Failed to parse incoming IMAP message: ${String(err)}`,
								});
								console.error("Error parsing IMAP message:", err);
								return;
							}

							const isToListen =
								addressObjectIncludes(parsed.to, config.listenAddress) ||
								addressObjectIncludes(parsed.cc, config.listenAddress) ||
								addressObjectIncludes(parsed.bcc, config.listenAddress);

							if (!isToListen) return;

							const emls = await extractEmlsFromIncomingMessage(parsed, config.listenAddress);
							for (let i = 0; i < emls.length; i++) {
								await createEmailSubmissionFromEml(
									emls[i],
									`${sourcePrefix}${emls.length > 1 ? `:att${i + 1}` : ""}`
								);
							}

							try {
								await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
							} catch (e) {
								console.error("Failed to mark IMAP message as seen:", e);
							}
						} catch (err) {
							console.error("Error processing IMAP message:", err);
						}
					};

					const processRange = async (range: string, reason: string) => {
						console.log(`Processing ${reason} IMAP messages in range ${range}...`);
						for await (const msg of client.fetch(range, { uid: true, source: true, flags: true, envelope: true })) {
							await processFetchedMessage(msg);
						}
					};

					const initialExists = mailboxExists();
					if (initialExists > 0) {
						await processRange(`1:${initialExists}`, "existing");
					}

					let lastExists = mailboxExists();

					while (!stopped) {
						try {
							await client.idle();
						} catch (err) {
							if (stopped) break;
							if (isNoConnectionError(err)) {
								console.warn("IMAP connection lost during IDLE, reconnecting...");
							} else {
								console.error("IMAP idle error, reconnecting session:", err);
							}
							throw err;
						}

						const currentExists = mailboxExists();
						if (currentExists < lastExists) {
							lastExists = currentExists;
							continue;
						}
						if (currentExists === lastExists) continue;

						const range = `${lastExists + 1}:${currentExists}`;
						lastExists = currentExists;

						await processRange(range, "new");
					}
				} finally {
					try {
						lock.release();
					} catch {
						// ignore
					}
				}
			} catch (err) {
				if (stopped) break;
				if (!isNoConnectionError(err)) {
					console.error("IMAP listener session error:", err);
				}
				await sleep(2_000);
			} finally {
				activeClient = null;
				try {
					client.close();
				} catch {
					// ignore
				}
			}
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		console.log("IMAP listener stopped.");
	}
}
