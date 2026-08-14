import crypto from "node:crypto";

import MailComposer from "nodemailer/lib/mail-composer";
import nodemailer from "nodemailer";

import { AbuseRepository } from "../repository";
import { normalizeDomain } from "../security";
import { attachmentFilename } from "./shared";
import {
	type AbuseMailAttachment,
	type AbuseMailSendResult,
	type AbuseMailTransport,
	type CanonicalAbuseMail,
	SafeEmailDeliveryFailure,
} from "./types";

const HEADER_BREAK = /[\r\n\u0000]/;
const MAILBOX = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function safeHeader(name: string, value: string): string {
	if (HEADER_BREAK.test(value)) throw new Error(`${name} contains an invalid control character.`);
	const result = value.trim();
	if (!result) throw new Error(`${name} must not be empty.`);
	return result;
}

function normalizedMailbox(value: string): string {
	const candidate = safeHeader("Mailbox", value).replace(/^<|>$/g, "").toLowerCase();
	if (!MAILBOX.test(candidate)) throw new Error("Mailbox is invalid.");
	return candidate;
}

function configuredSender(): string {
	const configured = process.env.ABUSE_SMTP_FROM ?? process.env.SMTP_FROM;
	if (!configured) throw new Error("ABUSE_SMTP_FROM or SMTP_FROM must be configured.");
	const match = configured.match(/<([^<>]+)>/)?.[1] ?? configured;
	return normalizedMailbox(match);
}

function replyDomain(): string {
	const value = process.env.ABUSE_REPLY_DOMAIN ?? process.env.REPORT_REPLY_DOMAIN;
	const domain = value ? normalizeDomain(value) : undefined;
	if (!domain) throw new Error("ABUSE_REPLY_DOMAIN must be configured as a public domain.");
	return domain;
}

function createReplyIdentity(): { address: string; token: string } {
	const token = crypto.randomBytes(24).toString("hex");
	return { token, address: `abuse-${token}@${replyDomain()}` };
}

function createMessageId(): string {
	return `<abuse-${crypto.randomBytes(24).toString("hex")}@${replyDomain()}>`;
}

/** Build the exact MIME bytes that will be handed to SMTP. */
export async function buildCanonicalAbuseMail(params: {
	to: string[];
	subject: string;
	textBody: string;
	attachments?: AbuseMailAttachment[];
	from?: string;
	correlationKey?: string;
	/** Reuse the route-owned reply address when retrying a known delivery failure. */
	replyAddress?: string;
}): Promise<CanonicalAbuseMail> {
	const from = normalizedMailbox(params.from ?? configuredSender());
	const to = [...new Set(params.to.map(normalizedMailbox))];
	if (to.length === 0) throw new Error("At least one abuse recipient is required.");
	const subject = safeHeader("Subject", params.subject);
	const textBody = params.textBody.replace(/\u0000/g, " ").trim();
	if (!textBody) throw new Error("Abuse message body must not be empty.");
	const identity = params.replyAddress
		? { address: normalizedMailbox(params.replyAddress), token: "" }
		: createReplyIdentity();
	const messageId = createMessageId();
	const correlationKey = safeHeader("Correlation key", params.correlationKey ?? identity.token);
	const composer = new MailComposer({
		from,
		to,
		replyTo: identity.address,
		messageId,
		subject,
		text: `${textBody}\n`,
		headers: {
			"X-Abuse-Report-Correlation": correlationKey,
		},
		attachments: (params.attachments ?? []).map((attachment) => ({
			filename: attachmentFilename(attachment.filename),
			content: attachment.content,
			contentType: safeHeader("Attachment MIME type", attachment.mimeType),
		})),
		disableFileAccess: true,
		disableUrlAccess: true,
	});
	return {
		from,
		to,
		subject,
		textBody,
		replyAddress: identity.address,
		correlationKey,
		messageId,
		rawMime: await composer.compile().build(),
	};
}

function configuredTransport(): AbuseMailTransport | undefined {
	const host = process.env.ABUSE_SMTP_HOST ?? process.env.SMTP_HOST;
	const user = process.env.ABUSE_SMTP_USER ?? process.env.SMTP_USER;
	const pass = process.env.ABUSE_SMTP_PASS ?? process.env.SMTP_PASS;
	if (!host || !user || !pass) return undefined;
	const port = Number(process.env.ABUSE_SMTP_PORT ?? process.env.SMTP_PORT ?? 587);
	const secure = (process.env.ABUSE_SMTP_SECURE ?? process.env.SMTP_SECURE) === "true" || port === 465;
	return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

function isKnownSmtpRejection(error: unknown): boolean {
	const candidate = error as { responseCode?: unknown; code?: unknown } | undefined;
	const responseCode = typeof candidate?.responseCode === "number" ? candidate.responseCode : undefined;
	if (responseCode !== undefined) return responseCode >= 400 && responseCode < 600;
	const code = typeof candidate?.code === "string" ? candidate.code.toUpperCase() : "";
	return ["EENVELOPE", "EMESSAGE", "EADDRINUSE", "EADDRNOTAVAIL", "EINVALIDRECIPIENT"].includes(code);
}

/**
 * Persist canonical MIME before SMTP. A transport error after `DATA` is not
 * reliably distinguishable from successful provider acceptance, so only an
 * explicit SMTP rejection is marked safe-to-retry.
 */
export async function sendAbuseEmailRoute(params: {
	routeId: bigint;
	runId: bigint;
	reportId: bigint;
	recipient: string;
	subject: string;
	body: string;
	attachments?: AbuseMailAttachment[];
	transport?: AbuseMailTransport;
	correlationKey: string;
	replyAddress?: string;
}): Promise<AbuseMailSendResult> {
	let mail: CanonicalAbuseMail;
	let storedMessageId: bigint;
	try {
		mail = await buildCanonicalAbuseMail({
			to: [params.recipient],
			subject: params.subject,
			textBody: params.body,
			attachments: params.attachments,
			correlationKey: params.correlationKey,
			replyAddress: params.replyAddress,
		});
		const rawArtifactId = await AbuseRepository.saveArtifact({
			reportId: params.reportId,
			routeId: params.routeId,
			runId: params.runId,
			name: `outbound-${mail.messageId.slice(1, -1)}.eml`,
			kind: "outbound_mail_mime",
			mimeType: "message/rfc822",
			buffer: mail.rawMime,
			metadata: { messageId: mail.messageId, correlationKey: mail.correlationKey },
		});
		const attachmentArtifactIds = await Promise.all(
			(params.attachments ?? []).map((attachment) =>
				AbuseRepository.saveArtifact({
					reportId: params.reportId,
					routeId: params.routeId,
					runId: params.runId,
					name: attachmentFilename(attachment.filename),
					kind: "outbound_mail_attachment",
					mimeType: attachment.mimeType,
					buffer: attachment.content,
				}),
			),
		);
		storedMessageId = await AbuseRepository.createOutboundMail({
			reportId: params.reportId,
			routeId: params.routeId,
			runId: params.runId,
			fromAddress: mail.from,
			toAddresses: mail.to,
			subject: mail.subject,
			textBody: mail.textBody,
			messageId: mail.messageId,
			replyAddress: mail.replyAddress,
			correlationKey: mail.correlationKey,
			rawArtifactId,
			attachmentArtifactIds,
		});
	} catch (error) {
		throw new SafeEmailDeliveryFailure(
			`Unable to prepare the canonical abuse email before SMTP: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}

	const transport = params.transport ?? configuredTransport();
	if (!transport) {
		try {
			await AbuseRepository.settleOutboundMail({ messageId: storedMessageId, status: "failed", error: "SMTP transport is not configured." });
		} catch (error) {
			throw new SafeEmailDeliveryFailure(
				`SMTP is not configured and the local failed-delivery record could not be stored: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		return { messageId: storedMessageId, status: "failed", error: "SMTP transport is not configured.", rfcMessageId: mail.messageId };
	}

	let result: { messageId?: string };
	try {
		result = await transport.sendMail({ raw: mail.rawMime, envelope: { from: mail.from, to: mail.to } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isKnownSmtpRejection(error)) {
			try {
				await AbuseRepository.settleOutboundMail({ messageId: storedMessageId, status: "failed", error: message });
			} catch (settlementError) {
				// The SMTP server explicitly rejected this message, so a local write
				// failure here remains safe to recover and retry with the same route
				// correlation identity.
				throw new SafeEmailDeliveryFailure(
					`SMTP rejected the message but the local failed-delivery record could not be stored: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`,
					{ cause: settlementError },
				);
			}
			return { messageId: storedMessageId, status: "failed", error: message, rfcMessageId: mail.messageId };
		}
		return { messageId: storedMessageId, status: "unknown_external_state", error: message, rfcMessageId: mail.messageId };
	}

	try {
		// A `false` result means a correlated bounce won the race and already
		// recorded the stronger known failure. SMTP did accept this attempt, but
		// the worker's subsequent compare-and-set will harmlessly leave that
		// bounced route untouched.
		await AbuseRepository.settleOutboundMail({ messageId: storedMessageId, status: "sent" });
		return { messageId: storedMessageId, status: "sent", rfcMessageId: result.messageId ?? mail.messageId };
	} catch (error) {
		// This happens after `sendMail` fulfilled, so provider acceptance is
		// possible even though our local sent marker was not persisted. It must
		// cross the ambiguity boundary instead of entering the retry path above.
		return {
			messageId: storedMessageId,
			status: "unknown_external_state",
			error: `SMTP accepted the message but local settlement failed: ${error instanceof Error ? error.message : String(error)}`,
			rfcMessageId: result.messageId ?? mail.messageId,
		};
	}
}
