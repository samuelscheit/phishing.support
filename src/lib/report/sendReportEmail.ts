import MailComposer from "nodemailer/lib/mail-composer";

import { ArtifactsEntity, ReportMessagesEntity, ReportThreadsEntity } from "../db/entities";
import { mailer } from "../utils";
import {
	assertSafeHeaderValue,
	createReplyIdentity,
	createRfcMessageId,
	extractNormalizedAddresses,
	getConfiguredReportReplyDomain,
	normalizeReportRecipients,
} from "./correspondence";
import type { ReportDraft } from "./generateReportDraft";

export type ReportAttachment = {
	filename: string;
	content: Buffer;
	contentType?: string;
};

export type ReportSendResult = {
	threadId: bigint;
	messageId: bigint;
	rfcMessageId: string;
	replyAddress: string;
	deliveryStatus: "sent" | "failed";
	providerMessageId?: string;
	error?: string;
};

type MailTransport = {
	sendMail(options: {
		raw: Buffer;
		envelope: { from: string; to: string[] };
	}): Promise<{ messageId?: string }>;
};

function attachmentName(filename: string, index: number): string {
	const safe = assertSafeHeaderValue("Attachment filename", filename).replaceAll(/[\\/]/g, "_");
	return safe || `attachment-${index + 1}`;
}

async function buildCanonicalMime(params: {
	from: string;
	recipients: string[];
	replyAddress: string;
	rfcMessageId: string;
	replyToken: string;
	subject: string;
	body: string;
	attachments: ReportAttachment[];
}): Promise<Buffer> {
	const composer = new MailComposer({
		from: params.from,
		to: params.recipients,
		replyTo: params.replyAddress,
		messageId: params.rfcMessageId,
		subject: params.subject,
		text: `${params.body}\n\n`,
		headers: {
			"X-Phishing-Report-Thread": params.replyToken,
		},
		attachments: params.attachments.map((attachment, index) => ({
			filename: attachmentName(attachment.filename, index),
			content: attachment.content,
			contentType: attachment.contentType,
		})),
		disableFileAccess: true,
		disableUrlAccess: true,
	});

	return composer.compile().build();
}

/**
 * Sends one SMTP abuse report with a durable, opaque reply identity. It writes
 * the thread and pending message before SMTP to make an immediate IMAP reply
 * routable, and never changes submission classification on its own.
 */
export async function sendReportEmail(params: {
	submissionId: bigint;
	analysisRunId?: bigint;
	draft: ReportDraft;
	attachments?: ReportAttachment[];
	data?: unknown;
	/** Injectable transport used by tests; production uses the configured SMTP transport. */
	transport?: MailTransport;
}): Promise<ReportSendResult> {
	const from = assertSafeHeaderValue("SMTP_FROM", process.env.SMTP_FROM);
	const subject = assertSafeHeaderValue("Report subject", params.draft.subject);
	const body = String(params.draft.body ?? "");
	if (/\u0000/.test(body)) throw new Error("Report body must not contain a NUL byte.");
	if (!from) throw new Error("SMTP_FROM must be configured with an authenticated sender address.");
	if (!subject) throw new Error("Report subject must not be empty.");
	if (!body) throw new Error("Report body must not be empty.");
	const senderAddresses = extractNormalizedAddresses(from);
	if (senderAddresses.length !== 1) throw new Error("SMTP_FROM must contain exactly one valid mailbox address.");
	const envelopeFrom = senderAddresses[0];

	const recipients = normalizeReportRecipients(params.draft.to);
	const replyDomain = getConfiguredReportReplyDomain();
	const identity = createReplyIdentity(replyDomain);
	const rfcMessageId = createRfcMessageId(replyDomain);
	const attachments = params.attachments ?? [];

	const { threadId, messageId } = await ReportThreadsEntity.createWithPendingOutbound({
		submissionId: params.submissionId,
		analysisRunId: params.analysisRunId ?? params.draft.analysisRunId,
		to: recipients,
		subject,
		replyAddress: identity.replyAddress,
		replyToken: identity.replyToken,
		data: params.data,
		from,
		textBody: body,
		rfcMessageId,
	});

	try {
		const rawMime = await buildCanonicalMime({
			from,
			recipients,
			replyAddress: identity.replyAddress,
			rfcMessageId,
			replyToken: identity.replyToken,
			subject,
			body,
			attachments,
		});

		// A canonical artifact preserves exactly the MIME payload handed to SMTP.
		const rawArtifactId = await ArtifactsEntity.saveBuffer({
			submissionId: params.submissionId,
			name: `abuse-report-${threadId.toString()}.eml`,
			kind: "report_eml",
			mimeType: "message/rfc822",
			buffer: rawMime,
		});
		const attachmentArtifactIds = await Promise.all(
			attachments.map((attachment, index) =>
				ArtifactsEntity.saveBuffer({
					submissionId: params.submissionId,
					name: attachmentName(attachment.filename, index),
					kind: "report_attachment",
					mimeType: attachment.contentType ?? "application/octet-stream",
					buffer: attachment.content,
				}),
			),
		);

		await ReportMessagesEntity.setOutboundArtifacts(messageId, {
			rawArtifactId,
			attachmentArtifactIds,
		});

		const transport = params.transport ?? mailer;
		if (!transport) throw new Error("SMTP transport is not configured.");
		const transportResult = await transport.sendMail({
			raw: rawMime,
			envelope: {
				from: envelopeFrom,
				to: recipients,
			},
		});
		const providerMessageId = transportResult.messageId || rfcMessageId;
		await ReportMessagesEntity.settleOutbound({ threadId, messageId, result: "sent", providerMessageId });

		return {
			threadId,
			messageId,
			rfcMessageId,
			replyAddress: identity.replyAddress,
			deliveryStatus: "sent",
			providerMessageId,
		};
	} catch (error) {
		const errorText = error instanceof Error ? error.message : String(error);
		await ReportMessagesEntity.settleOutbound({ threadId, messageId, result: "failed", error: errorText });
		return {
			threadId,
			messageId,
			rfcMessageId,
			replyAddress: identity.replyAddress,
			deliveryStatus: "failed",
			error: errorText,
		};
	}
}
