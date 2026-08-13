import { type AddressObject, type EmailAddress, simpleParser, type ParsedMail } from "mailparser";

import { resolveIncomingMailRoute } from "@/lib/imap/routing";
import { ArtifactsEntity, MailIngestEntity, ReportMessagesEntity, ReportThreadsEntity, SubmissionsEntity } from "@/lib/db/entities";
import {
	classifyIncomingMessage,
	extractNormalizedAddresses,
	normalizeDiagnosticThreadToken,
	normalizeEmailAddress,
	normalizeMessageId,
	parseMessageIdList,
	sanitizeCorrespondenceHtml,
} from "@/lib/report/correspondence";
import { extractEmlsFromIncomingMessage } from "@/lib/mail_forwarded";
import { createEmailSubmissionFromEml, type EmailSubmissionOptions } from "@/lib/submissions/email";

type EnvelopeAddress = { address?: string | null };

export type IncomingMailEnvelope = {
	to?: EnvelopeAddress[];
	cc?: EnvelopeAddress[];
	bcc?: EnvelopeAddress[];
	messageId?: string;
};

/** The listener-specific portion of an IMAP FETCH response needed for ingest. */
export type FetchedIncomingMail = {
	uid: number;
	source?: Buffer | Uint8Array | string;
	flags?: ReadonlySet<string> | { has(flag: string): boolean } | readonly string[];
	envelope?: IncomingMailEnvelope;
	internalDate?: Date | string;
};

export type IncomingMailIngestConfig = {
	mailbox: string;
	uidValidity: number;
	intakeAddress: string;
	/** Existing public-intake behavior may opt out of already-read mail. Replies never do. */
	processSeen: boolean;
};

export type IntakeSubmissionCreator = (emlContent: string, options: EmailSubmissionOptions) => Promise<bigint>;

export type IncomingMailIngestResult =
	| { disposition: "terminal"; route: "reply" | "intake" | "ignored" | "failed"; reason: string; reportMessageId?: bigint }
	| { disposition: "skipped"; route: "intake"; reason: "already_seen" }
	| { disposition: "retry"; reason: string };

function headerValueStrings(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.flatMap(headerValueStrings);
	if (typeof value === "string") return [value];
	if (value instanceof Date) return [value.toUTCString()];
	if (typeof value === "object") {
		const candidate = value as { value?: unknown; text?: unknown };
		if (typeof candidate.text === "string") return [candidate.text];
		if (typeof candidate.value === "string") return [candidate.value];
	}
	return [String(value)];
}

function headerValues(parsed: ParsedMail, name: string): string[] {
	const normalizedName = name.toLowerCase();
	const lines = parsed.headerLines
		.filter((line) => line.key.toLowerCase() === normalizedName)
		.map((line) => line.line.slice(line.line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim());
	return lines.length > 0 ? lines : headerValueStrings(parsed.headers.get(normalizedName));
}

function flattenAddresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
	const objects = Array.isArray(value) ? value : value ? [value] : [];
	const result: EmailAddress[] = [];
	const visit = (address: EmailAddress) => {
		result.push(address);
		for (const nested of address.group ?? []) visit(nested);
	};
	for (const object of objects) for (const address of object.value ?? []) visit(address);
	return result;
}

function displayAddresses(value: AddressObject | AddressObject[] | undefined): string {
	return flattenAddresses(value)
		.map((address) => {
			const mailbox = normalizeEmailAddress(address.address);
			if (!mailbox) return undefined;
			return address.name?.trim() ? `${address.name.trim()} <${mailbox}>` : mailbox;
		})
		.filter((address): address is string => Boolean(address))
		.join(", ");
}

function parsedAddressField(parsed: ParsedMail, field: "to" | "cc" | "bcc"): string[] {
	return extractNormalizedAddresses([
		...flattenAddresses(parsed[field]).map((address) => address.address ?? ""),
		...headerValues(parsed, field),
	]);
}

function routingRecipients(parsed: ParsedMail, message: FetchedIncomingMail): string[] {
	const envelopeRecipients = [
		...(message.envelope?.to ?? []),
		...(message.envelope?.cc ?? []),
		...(message.envelope?.bcc ?? []),
	]
		.map((entry) => entry.address ?? "")
		.filter(Boolean);

	return extractNormalizedAddresses([
		...parsedAddressField(parsed, "to"),
		...parsedAddressField(parsed, "cc"),
		...parsedAddressField(parsed, "bcc"),
		...headerValues(parsed, "delivered-to"),
		...headerValues(parsed, "x-original-to"),
		...envelopeRecipients,
	]);
}

function safeAttachmentName(value: string | undefined, index: number): string {
	const cleaned = (value ?? `attachment-${index + 1}`).replace(/[\r\n\0\\/]/g, "_").trim().slice(0, 180);
	return cleaned || `attachment-${index + 1}`;
}

function messageOccurredAt(parsed: ParsedMail, message: FetchedIncomingMail): Date {
	const candidate = parsed.date ?? message.internalDate;
	const date = candidate instanceof Date ? candidate : candidate ? new Date(candidate) : new Date();
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isSeen(flags: FetchedIncomingMail["flags"]): boolean {
	if (!flags) return false;
	if (typeof (flags as { has?: unknown }).has === "function") return (flags as { has(flag: string): boolean }).has("\\Seen");
	return Array.isArray(flags) && flags.includes("\\Seen");
}

async function saveIncomingArtifacts(params: { parsed: ParsedMail; raw: Buffer; submissionId: bigint; threadId: bigint; uid: number }) {
	const rawArtifactId = await ArtifactsEntity.saveBuffer({
		submissionId: params.submissionId,
		name: `report-reply-${params.threadId.toString()}-${params.uid}.eml`,
		kind: "report_reply_eml",
		mimeType: "message/rfc822",
		buffer: params.raw,
	});
	const attachmentArtifactIds = await Promise.all(
		params.parsed.attachments.map((attachment, index) =>
			ArtifactsEntity.saveBuffer({
				submissionId: params.submissionId,
				name: safeAttachmentName(attachment.filename, index),
				kind: "report_reply_attachment",
				mimeType: attachment.contentType || "application/octet-stream",
				buffer: Buffer.from(attachment.content),
			}),
		),
	);
	return { rawArtifactId, attachmentArtifactIds };
}

function pushLookup(map: Map<string, bigint[]>, key: string | undefined, threadId: bigint) {
	if (!key) return;
	const values = map.get(key) ?? [];
	if (!values.includes(threadId)) values.push(threadId);
	map.set(key, values);
}

async function resolveReportThread(params: {
	recipients: string[];
	inReplyTo: string[];
	references: string[];
	diagnosticThreadTokens: string[];
	intakeAddress: string;
}) {
	const diagnosticThreadTokens = params.diagnosticThreadTokens
		.map((token) => normalizeDiagnosticThreadToken(token))
		.filter((token): token is string => Boolean(token));
	const outboundIds = [...new Set([...params.inReplyTo, ...params.references])];
	const [recipientRows, outboundRows, diagnosticRows] = await Promise.all([
		ReportThreadsEntity.findByReplyAddresses(params.recipients),
		ReportMessagesEntity.findThreadsByOutboundMessageIds(outboundIds),
		diagnosticThreadTokens.length > 0 ? ReportThreadsEntity.findByReplyTokens(diagnosticThreadTokens) : Promise.resolve([]),
	]);

	const byReplyAddress = new Map<string, bigint[]>();
	for (const row of recipientRows) pushLookup(byReplyAddress, row.replyAddress, row.id);
	const byOutboundMessageId = new Map<string, bigint[]>();
	for (const row of outboundRows) pushLookup(byOutboundMessageId, row.messageId ?? undefined, row.threadId);
	const byDiagnosticToken = new Map<string, bigint[]>();
	for (const row of diagnosticRows) pushLookup(byDiagnosticToken, row.replyToken, row.id);

	return resolveIncomingMailRoute(
		{
			recipients: params.recipients,
			inReplyTo: params.inReplyTo,
			references: params.references,
			diagnosticThreadToken: diagnosticThreadTokens,
			intakeAddress: params.intakeAddress,
		},
		{ byReplyAddress, byOutboundMessageId, byDiagnosticToken },
	);
}

async function ingestPublicIntake(params: {
	parsed: ParsedMail;
	config: IncomingMailIngestConfig;
	uid: number;
	createIntakeSubmission: IntakeSubmissionCreator;
}) {
	const mailboxKey = encodeURIComponent(params.config.mailbox);
	const sourcePrefix = `imap:${mailboxKey}:${params.config.uidValidity}:${params.uid}`;
	const historicalSubmission = await SubmissionsEntity.findIdBySourcePrefix(sourcePrefix);
	if (historicalSubmission) return;

	const emls = await extractEmlsFromIncomingMessage(params.parsed, params.config.intakeAddress);
	for (let index = 0; index < emls.length; index++) {
		await params.createIntakeSubmission(emls[index], {
			source: `${sourcePrefix}${emls.length > 1 ? `:att${index + 1}` : ""}`,
		});
	}
}

/**
 * Persists one fetched IMAP message. It deliberately has no IMAP client
 * dependency: callers mark the message seen only after a terminal result, and
 * tests can inject RFC 5322 fixtures without a live mailbox.
 */
export async function ingestFetchedIncomingMail(
	message: FetchedIncomingMail,
	config: IncomingMailIngestConfig,
	dependencies: { createIntakeSubmission?: IntakeSubmissionCreator } = {},
): Promise<IncomingMailIngestResult> {
	const ledgerKey = { mailbox: config.mailbox, uidValidity: config.uidValidity, uid: message.uid };
	let rawMessageId: string | undefined;

	try {
		const existingIngest = await MailIngestEntity.get(ledgerKey);
		if (existingIngest?.terminal) {
			return {
				disposition: "terminal",
				route: existingIngest.route,
				reason: "terminal_ledger_record",
				reportMessageId: existingIngest.reportMessageId ?? undefined,
			};
		}

		const raw = message.source ? Buffer.from(message.source) : undefined;
		if (!raw || raw.byteLength === 0) throw new Error("IMAP fetch did not include the RFC 5322 source.");
		const parsed = await simpleParser(raw, { skipTextToHtml: true });
		rawMessageId = headerValues(parsed, "message-id")[0]?.trim() || parsed.messageId?.trim() || message.envelope?.messageId?.trim();
		const messageId = normalizeMessageId(rawMessageId);
		const inReplyToHeaders = headerValues(parsed, "in-reply-to");
		const inReplyTo = parseMessageIdList(inReplyToHeaders.length > 0 ? inReplyToHeaders : parsed.inReplyTo);
		const referenceHeaders = headerValues(parsed, "references");
		const references = parseMessageIdList(
			referenceHeaders.length > 0
				? referenceHeaders
				: Array.isArray(parsed.references)
					? parsed.references
					: parsed.references
						? [parsed.references]
						: [],
		);
		const to = parsedAddressField(parsed, "to");
		const cc = parsedAddressField(parsed, "cc");
		const recipients = routingRecipients(parsed, message);
		const diagnosticThreadTokens = headerValues(parsed, "x-phishing-report-thread");
		const route = await resolveReportThread({
			recipients,
			inReplyTo,
			references,
			diagnosticThreadTokens,
			intakeAddress: config.intakeAddress,
		});

		if (route.route === "reply") {
			const thread = await ReportThreadsEntity.get(route.threadId);
			if (!thread) throw new Error(`Resolved report thread ${route.threadId.toString()} no longer exists.`);

			const existingMessage = await ReportMessagesEntity.findInboundByMessageId(messageId);
			if (existingMessage) {
				await MailIngestEntity.recordTerminal({
					...ledgerKey,
					messageId: rawMessageId,
					route: "reply",
					reportMessageId: existingMessage.id,
					reason: "duplicate_message_id",
				});
				return { disposition: "terminal", route: "reply", reason: "duplicate_message_id", reportMessageId: existingMessage.id };
			}

			const artifacts = await saveIncomingArtifacts({
				parsed,
				raw,
				submissionId: thread.submissionId,
				threadId: route.threadId,
				uid: message.uid,
			});
			const kind = classifyIncomingMessage({
				from: displayAddresses(parsed.from),
				subject: parsed.subject,
				contentType: headerValues(parsed, "content-type")[0],
				headers: parsed.headers as Map<string, unknown>,
			});
			const storedMessageId = await ReportMessagesEntity.persistInboundWithIngest({
				threadId: route.threadId,
				kind,
				from: displayAddresses(parsed.from) || undefined,
				to,
				cc,
				subject: parsed.subject || undefined,
				textBody: parsed.text?.trim() || undefined,
				htmlBody: sanitizeCorrespondenceHtml(typeof parsed.html === "string" ? parsed.html : undefined),
				messageId,
				inReplyTo: inReplyTo.length === 1 ? inReplyTo[0] : undefined,
				references,
				rawArtifactId: artifacts.rawArtifactId,
				attachmentArtifactIds: artifacts.attachmentArtifactIds,
				occurredAt: messageOccurredAt(parsed, message),
				...ledgerKey,
				rawMessageId,
				ingestReason: route.matchedBy,
			});
			return {
				disposition: "terminal",
				route: "reply",
				reason: storedMessageId ? "stored_report_reply" : "duplicate_imap_delivery",
				reportMessageId: storedMessageId,
			};
		}

		if (route.route === "intake") {
			if (!config.processSeen && isSeen(message.flags)) {
				return { disposition: "skipped", route: "intake", reason: "already_seen" };
			}
			await ingestPublicIntake({
				parsed,
				config,
				uid: message.uid,
				createIntakeSubmission: dependencies.createIntakeSubmission ?? createEmailSubmissionFromEml,
			});
			await MailIngestEntity.recordTerminal({ ...ledgerKey, messageId: rawMessageId, route: "intake" });
			return { disposition: "terminal", route: "intake", reason: "processed_public_intake" };
		}

		await MailIngestEntity.recordTerminal({
			...ledgerKey,
			messageId: rawMessageId,
			route: "ignored",
			reason: route.reason,
		});
		return { disposition: "terminal", route: "ignored", reason: route.reason };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		try {
			await MailIngestEntity.recordFailure({ ...ledgerKey, messageId: rawMessageId, reason });
		} catch (ingestError) {
			console.error(`Failed to write retryable IMAP ingest record for UID ${message.uid}:`, ingestError);
		}
		return { disposition: "retry", reason };
	}
}
