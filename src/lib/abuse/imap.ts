import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from "mailparser";

import { AbuseRepository } from "./repository";
import { extractUnambiguousVerificationCode, persistInboundAbuseMail } from "./mail";
import { gnameServiceIdentity } from "./registry";

type EnvelopeAddress = { address?: string | null };

export type FetchedAbuseMail = {
	uid: number;
	source?: Buffer | Uint8Array | string;
	flags?: ReadonlySet<string> | { has(flag: string): boolean } | readonly string[];
	envelope?: {
		to?: EnvelopeAddress[];
		cc?: EnvelopeAddress[];
		bcc?: EnvelopeAddress[];
		messageId?: string;
	};
	internalDate?: Date | string;
};

export type AbuseImapConfig = {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	pass: string;
	mailbox: string;
	processSeen: boolean;
};

export type AbuseMailIngestResult =
	| { disposition: "terminal"; route: "reply" | "ignored"; reason: string; messageId?: bigint }
	| { disposition: "retry"; reason: string };

function normalizeMailbox(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const candidate = value.trim().replace(/^<|>$/g, "").toLowerCase();
	if (candidate.length > 320 || /[\r\n\0]/.test(candidate)) return undefined;
	return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(candidate)
		? candidate
		: undefined;
}

function normalizeMessageId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const candidate = value.trim().replace(/^<|>$/g, "");
	if (!candidate || /[\r\n\s<>]/.test(candidate) || !candidate.includes("@")) return undefined;
	return `<${candidate}>`;
}

function headerStrings(parsed: ParsedMail, name: string): string[] {
	const wanted = name.toLowerCase();
	const fromLines = parsed.headerLines
		.filter((line) => line.key.toLowerCase() === wanted)
		.map((line) => line.line.slice(line.line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim());
	if (fromLines.length) return fromLines;
	const value = parsed.headers.get(wanted);
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap((item) => (typeof item === "string" ? [item] : []));
	return [];
}

function flattenAddresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
	const objects = Array.isArray(value) ? value : value ? [value] : [];
	const result: EmailAddress[] = [];
	const visit = (entry: EmailAddress) => {
		result.push(entry);
		for (const nested of entry.group ?? []) visit(nested);
	};
	for (const object of objects) for (const entry of object.value ?? []) visit(entry);
	return result;
}

function addressField(parsed: ParsedMail, field: "to" | "cc" | "bcc"): string[] {
	const parsedAddresses = flattenAddresses(parsed[field]).map((entry) => normalizeMailbox(entry.address)).filter((value): value is string => Boolean(value));
	const headerAddresses = headerStrings(parsed, field).flatMap((value) => value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map(normalizeMailbox).filter((value): value is string => Boolean(value));
	return [...new Set([...parsedAddresses, ...headerAddresses])];
}

function recipients(parsed: ParsedMail, message: FetchedAbuseMail): string[] {
	const envelope = [...(message.envelope?.to ?? []), ...(message.envelope?.cc ?? []), ...(message.envelope?.bcc ?? [])]
		.map((entry) => normalizeMailbox(entry.address))
		.filter((value): value is string => Boolean(value));
	const delivered = ["delivered-to", "x-original-to", "x-forwarded-to"].flatMap((name) =>
		headerStrings(parsed, name).flatMap((value) => value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map(normalizeMailbox).filter((item): item is string => Boolean(item)),
	);
	return [...new Set([...addressField(parsed, "to"), ...addressField(parsed, "cc"), ...addressField(parsed, "bcc"), ...delivered, ...envelope])];
}

function references(parsed: ParsedMail): string[] {
	const values = [...(parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : []), ...headerStrings(parsed, "references")];
	return [...new Set(values.flatMap((value) => value.match(/<[^<>\s]+@[^<>\s]+>/g) ?? []).map(normalizeMessageId).filter((value): value is string => Boolean(value)))];
}

function isSeen(flags: FetchedAbuseMail["flags"]): boolean {
	if (!flags) return false;
	if (typeof (flags as { has?: unknown }).has === "function") return (flags as { has(flag: string): boolean }).has("\\Seen");
	return Array.isArray(flags) && flags.includes("\\Seen");
}

function configuredGnameCodeSenderDomains(): string[] {
	return (process.env.ABUSE_GNAME_CODE_SENDER_DOMAINS ?? "gname.com")
		.split(",")
		.map((value) => value.trim().toLowerCase().replace(/\.+$/, ""))
		.filter((value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value));
}

function senderIsAllowedGnameCodeSource(parsed: ParsedMail): boolean {
	const senderDomains = flattenAddresses(parsed.from)
		.map((entry) => normalizeMailbox(entry.address)?.split("@")[1])
		.filter((value): value is string => Boolean(value));
	const allowed = configuredGnameCodeSenderDomains();
	return senderDomains.some((domain) => allowed.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`)));
}

/**
 * GNAME uses a shared service mailbox rather than one unique reply address.
 * The route lock permits at most one waiting task, so an exact recipient,
 * approved sender domain, and a single code can be correlated without ever
 * guessing between concurrent portal runs.
 */
async function routeSharedGnameCode(params: { parsed: ParsedMail; recipients: string[]; body: string }) {
	const mailbox = gnameServiceIdentity().mailbox;
	if (!mailbox || !params.recipients.includes(mailbox)) return undefined;
	if (!senderIsAllowedGnameCodeSource(params.parsed)) return undefined;
	if (!extractUnambiguousVerificationCode(params.body)) return undefined;
	return AbuseRepository.getWaitingCodeRoute();
}

/**
 * Parse and persist one abuse-mail message without any dependency on the
 * legacy public-intake/case tables. Raw MIME and attachments are persisted by
 * persistInboundAbuseMail before the classifier or TOTP worker is queued.
 */
export async function ingestFetchedAbuseMail(
	message: FetchedAbuseMail,
	config: Pick<AbuseImapConfig, "mailbox" | "processSeen"> & { uidValidity: number },
): Promise<AbuseMailIngestResult> {
	try {
		if (!config.processSeen && isSeen(message.flags)) return { disposition: "terminal", route: "ignored", reason: "already_seen" };
		const raw = message.source ? Buffer.from(message.source) : undefined;
		if (!raw?.byteLength) throw new Error("Abuse IMAP fetch did not include the RFC 5322 source.");
		const parsed = await simpleParser(raw, { skipTextToHtml: true });
		const messageId = normalizeMessageId(parsed.messageId ?? headerStrings(parsed, "message-id")[0] ?? message.envelope?.messageId);
		const inReplyTo = normalizeMessageId(parsed.inReplyTo ?? headerStrings(parsed, "in-reply-to")[0]);
		const recipientAddresses = recipients(parsed, message);
		const body = [parsed.text ?? "", typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : ""].join(" ");
		const route = (await AbuseRepository.findInboundRoute({ recipients: recipientAddresses, inReplyTo, references: references(parsed) }))
			?? await routeSharedGnameCode({ parsed, recipients: recipientAddresses, body });
		if (!route) return { disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" };

		const existingByMessageId = messageId ? await AbuseRepository.getInboundMailByMessageId(messageId) : undefined;
		if (existingByMessageId) return { disposition: "terminal", route: "reply", reason: "duplicate_message_id", messageId: existingByMessageId.id };
		const stored = await persistInboundAbuseMail({
			routeId: route.id,
			reportId: route.reportId,
			rawMime: raw,
			mailbox: config.mailbox,
			uidValidity: config.uidValidity,
			uid: message.uid,
		});
		if (!stored.created) return { disposition: "terminal", route: "reply", reason: "duplicate_imap_delivery", messageId: stored.messageId };
		await AbuseRepository.enqueueJob({
			jobType: "classify_provider_reply",
			reportId: route.reportId,
			routeId: route.id,
			payload: { messageId: stored.messageId.toString() },
			dedupeKey: `classify-abuse-mail:${stored.messageId.toString()}`,
		});
		const currentRoute = await AbuseRepository.getRoute(route.id);
		const code = extractUnambiguousVerificationCode(body);
		if (currentRoute?.status === "waiting_code" && code) {
			await AbuseRepository.enqueueJob({
				jobType: "send_totp_code",
				reportId: route.reportId,
				routeId: route.id,
				payload: { messageId: stored.messageId.toString(), totpIdentifier: currentRoute.serviceIdentity && typeof currentRoute.serviceIdentity.mailbox === "string" ? currentRoute.serviceIdentity.mailbox : undefined },
				dedupeKey: `send-totp:${route.id.toString()}:${stored.messageId.toString()}`,
			});
		}
		return { disposition: "terminal", route: "reply", reason: "stored_abuse_reply", messageId: stored.messageId };
	} catch (error) {
		return { disposition: "retry", reason: error instanceof Error ? error.message : String(error) };
	}
}

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
}

function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	return value === undefined ? fallback : ["1", "true", "yes"].includes(value.toLowerCase());
}

export function getAbuseImapConfig(): AbuseImapConfig | undefined {
	const required = ["ABUSE_IMAP_HOST", "ABUSE_IMAP_USER", "ABUSE_IMAP_PASS", "ABUSE_IMAP_MAILBOX"];
	if (required.some((name) => !process.env[name]?.trim())) return undefined;
	return {
		host: requiredEnv("ABUSE_IMAP_HOST"),
		port: envInt("ABUSE_IMAP_PORT", 993),
		secure: envBool("ABUSE_IMAP_SECURE", true),
		user: requiredEnv("ABUSE_IMAP_USER"),
		pass: requiredEnv("ABUSE_IMAP_PASS"),
		mailbox: requiredEnv("ABUSE_IMAP_MAILBOX"),
		processSeen: envBool("ABUSE_IMAP_PROCESS_SEEN", true),
	};
}

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
