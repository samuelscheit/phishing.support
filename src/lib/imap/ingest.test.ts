import { beforeEach, describe, expect, test } from "bun:test";

import {
	AnalysisRunsEntity,
	ArtifactsEntity,
	MailIngestEntity,
	ReportMessagesEntity,
	ReportThreadsEntity,
	SubmissionsEntity,
} from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { getSubmissionDetails } from "../submissions/details";
import { ingestFetchedIncomingMail, type FetchedIncomingMail, type IncomingMailIngestConfig } from "./ingest";

useTemporaryDatabase();

const config: IncomingMailIngestConfig = {
	mailbox: "phishing.report",
	uidValidity: 73,
	intakeAddress: "report@phishing.support",
	processSeen: false,
};

function eml(headers: Record<string, string>, body: string, parts?: Array<{ filename: string; content: string; contentType?: string }>) {
	const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
	if (!parts?.length) return Buffer.from([...headerLines, "", body].join("\r\n"));

	const boundary = "mail-boundary-8bc7a4";
	return Buffer.from([
		...headerLines,
		"MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		body,
		...parts.flatMap((part) => [
			`--${boundary}`,
			`Content-Type: ${part.contentType ?? "application/octet-stream"}; name="${part.filename}"`,
			`Content-Disposition: attachment; filename="${part.filename}"`,
			"Content-Transfer-Encoding: base64",
			"",
			Buffer.from(part.content, "utf-8").toString("base64"),
		]),
		`--${boundary}--`,
		"",
	].join("\r\n"));
}

function fetched(uid: number, source: Buffer, options: Partial<FetchedIncomingMail> = {}): FetchedIncomingMail {
	return {
		uid,
		source,
		internalDate: new Date("2026-08-13T12:00:00.000Z"),
		...options,
	};
}

async function createThread(key: string, replyToken = "0123456789abcdef0123456789abcdef") {
	const submissionId = await SubmissionsEntity.create({
		kind: "website",
		data: { kind: "website", website: { url: `https://${key}.example.test/path` } },
		dedupeKey: key,
	});
	const replyAddress = `case-${replyToken}@phishing.support`;
	const outboundMessageId = `<outbound-${key}@phishing.support>`;
	const created = await ReportThreadsEntity.createWithPendingOutbound({
		submissionId,
		to: ["abuse@example.test"],
		subject: `Abuse report ${key}`,
		replyAddress,
		replyToken,
		from: "support@phishing.support",
		textBody: "Please investigate.",
		rfcMessageId: outboundMessageId,
	});
	await ReportMessagesEntity.settleOutbound({
		threadId: created.threadId,
		messageId: created.messageId,
		result: "sent",
		providerMessageId: `provider-${key}`,
	});
	return { submissionId, replyAddress, outboundMessageId, ...created };
}

describe("IMAP correspondence ingest", () => {
	test("assigns an already-seen reply by generated identity, stores its raw message and attachment, and never creates an analysis", async () => {
		const thread = await createThread("imap-reply");
		const source = eml(
			{
				From: "Abuse Desk <abuse@example.test>",
				To: `Generated Address <${thread.replyAddress.toUpperCase()}>`,
				"Message-ID": "<reply-one@example.test>",
				"In-Reply-To": thread.outboundMessageId,
				References: `${thread.outboundMessageId} <earlier@example.test>`,
				Subject: "Case received",
				Date: "Thu, 13 Aug 2026 12:00:00 +0000",
			},
			"We have received your report.",
			[{ filename: "case-note.txt", content: "Ticket #123" }],
		);

		const result = await ingestFetchedIncomingMail(
			fetched(44, source, {
				flags: new Set(["\\Seen"]),
				envelope: { to: [{ address: thread.replyAddress }] },
			}),
			config,
		);

		expect(result).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_report_reply" });
		const storedThread = await ReportThreadsEntity.get(thread.threadId);
		const messages = await ReportMessagesEntity.listForThread(thread.threadId);
		expect(storedThread?.status).toBe("replied");
		expect(messages).toHaveLength(2);
		const inbound = messages.find((message) => message.direction === "inbound");
		expect(inbound).toMatchObject({
			kind: "reply",
			status: "received",
			from: "Abuse Desk <abuse@example.test>",
			to: [thread.replyAddress],
			messageId: "<reply-one@example.test>",
			inReplyTo: thread.outboundMessageId,
			textBody: "We have received your report.",
		});
		expect(inbound?.attachmentArtifactIds).toHaveLength(1);
		expect(inbound?.rawArtifactId).toBeDefined();

		const rawArtifact = await ArtifactsEntity.get(inbound!.rawArtifactId!);
		const attachment = await ArtifactsEntity.get(BigInt(inbound!.attachmentArtifactIds[0]!));
		expect(rawArtifact?.blob.equals(source)).toBeTrue();
		expect(attachment?.blob.toString()).toBe("Ticket #123");
		expect(await AnalysisRunsEntity.listForSubmission(thread.submissionId)).toEqual([]);

		const detail = await getSubmissionDetails(thread.submissionId.toString());
		expect(detail?.reportThreads).toHaveLength(1);
		expect(detail?.reportThreads[0]?.messages).toHaveLength(2);
		expect(detail?.reportThreads[0]?.messages.find((message) => message.direction === "inbound")).toMatchObject({
		inReplyTo: thread.outboundMessageId,
		references: [thread.outboundMessageId, "<earlier@example.test>"],
		attachmentArtifactIds: [expect.any(String)],
	});
		expect((await MailIngestEntity.get({ mailbox: config.mailbox, uidValidity: config.uidValidity, uid: 44 }))?.route).toBe("reply");
	});

	test("uses Delivered-To and X-Original-To recipient headers and persists auto replies and bounces", async () => {
		const autoThread = await createThread("imap-auto", "11111111111111111111111111111111");
		const autoResult = await ingestFetchedIncomingMail(
			fetched(
				45,
				eml(
					{
						From: "Abuse Desk <abuse@example.test>",
						To: "Undisclosed recipients:;",
						"Delivered-To": `Reply Mailbox <${autoThread.replyAddress.toUpperCase()}>`,
						"Message-ID": "<auto-reply@example.test>",
						"In-Reply-To": autoThread.outboundMessageId,
						"Auto-Submitted": "auto-replied",
						Subject: "Out of office",
					},
					"I am unavailable.",
				),
			),
			config,
		);
		expect(autoResult).toMatchObject({ disposition: "terminal", route: "reply" });
		expect((await ReportMessagesEntity.listForThread(autoThread.threadId)).find((message) => message.direction === "inbound")).toMatchObject({
			kind: "auto_reply",
			status: "received",
		});
		expect((await ReportThreadsEntity.get(autoThread.threadId))?.status).toBe("replied");

		const bounceThread = await createThread("imap-bounce", "22222222222222222222222222222222");
		const bounceResult = await ingestFetchedIncomingMail(
			fetched(
				46,
				eml(
					{
						From: "MAILER-DAEMON <mailer-daemon@example.test>",
						To: "Undisclosed recipients:;",
						"X-Original-To": bounceThread.replyAddress,
						"Message-ID": "<bounce@example.test>",
						"In-Reply-To": bounceThread.outboundMessageId,
						"Content-Type": "multipart/report; report-type=delivery-status",
						Subject: "Delivery Status Notification (Failure)",
					},
					"Your message could not be delivered.",
				),
			),
			config,
		);
		expect(bounceResult).toMatchObject({ disposition: "terminal", route: "reply" });
		expect((await ReportMessagesEntity.listForThread(bounceThread.threadId)).find((message) => message.direction === "inbound")).toMatchObject({
			kind: "bounce",
			status: "received",
		});
		expect((await ReportThreadsEntity.get(bounceThread.threadId))?.status).toBe("delivery_failed");
	});

	test("deduplicates both an IMAP UID and a repeated RFC Message-ID", async () => {
		const thread = await createThread("imap-duplicates", "33333333333333333333333333333333");
		const source = eml(
			{
				From: "Abuse Desk <abuse@example.test>",
				To: thread.replyAddress,
				"Message-ID": "<duplicate@example.test>",
				"In-Reply-To": thread.outboundMessageId,
				Subject: "Received",
			},
			"One message, delivered more than once.",
		);

		expect(await ingestFetchedIncomingMail(fetched(47, source), config)).toMatchObject({ disposition: "terminal", route: "reply" });
		expect(await ingestFetchedIncomingMail(fetched(47, source), config)).toEqual({
			disposition: "terminal",
			route: "reply",
			reason: "terminal_ledger_record",
		reportMessageId: expect.any(BigInt),
	});
		expect(await ingestFetchedIncomingMail(fetched(48, source), config)).toMatchObject({
			disposition: "terminal",
			route: "reply",
			reason: "duplicate_message_id",
		});
		expect((await ReportMessagesEntity.listForThread(thread.threadId)).filter((message) => message.direction === "inbound")).toHaveLength(1);
		expect(await MailIngestEntity.get({ mailbox: config.mailbox, uidValidity: config.uidValidity, uid: 48 })).toMatchObject({
		terminal: true,
		route: "reply",
		reason: "duplicate_message_id",
	});
	});

	test("records unmatched mail as ignored without copying its body, attachments, or creating a submission", async () => {
		const submissionId = await SubmissionsEntity.create({
			kind: "website",
			data: { kind: "website", website: { url: "https://existing.example.test" } },
			dedupeKey: "ignored-mail-existing-submission",
		});
		const result = await ingestFetchedIncomingMail(
			fetched(
				49,
				eml(
					{
						From: "Unrelated <unrelated@example.test>",
						To: "unmatched@phishing.support",
						"Message-ID": "<ignored@example.test>",
						Subject: "Unrelated mailbox message",
					},
					"This must remain only in IMAP.",
					[{ filename: "unrelated.txt", content: "do not store me" }],
				),
			),
			config,
		);

		expect(result).toEqual({ disposition: "terminal", route: "ignored", reason: "no_report_thread_match" });
		expect(await MailIngestEntity.get({ mailbox: config.mailbox, uidValidity: config.uidValidity, uid: 49 })).toMatchObject({
			route: "ignored",
			terminal: true,
			reason: "no_report_thread_match",
		});
		expect(await ArtifactsEntity.listForSubmission(submissionId)).toEqual([]);
	});

	test("keeps normal report@ intake behavior while leaving already-seen intake mail untouched", async () => {
		const embedded = [
			"From: Original Sender <original@example.test>",
			"To: report@phishing.support",
			"Subject: Forwarded phishing message",
			"",
			"Suspicious content.",
		].join("\r\n");
		const source = eml(
			{
				From: "Reporter <reporter@example.test>",
				To: "report@phishing.support",
				"Message-ID": "<public-intake@example.test>",
				Subject: "Forwarded message",
			},
			"See attached.",
			[{ filename: "original.eml", content: embedded, contentType: "message/rfc822" }],
		);
		const created: Array<{ eml: string; source?: string }> = [];
		const createIntakeSubmission = async (emlContent: string, options: { source?: string }) => {
			created.push({ eml: emlContent, source: options.source });
			return 999n;
		};

		expect(await ingestFetchedIncomingMail(fetched(50, source), config, { createIntakeSubmission })).toEqual({
			disposition: "terminal",
			route: "intake",
			reason: "processed_public_intake",
		});
		expect(created).toHaveLength(1);
		expect(created[0]?.eml).toContain("Original Sender");
		expect(created[0]?.source).toBe("imap:phishing.report:73:50");
		expect(await MailIngestEntity.get({ mailbox: config.mailbox, uidValidity: config.uidValidity, uid: 50 })).toMatchObject({ route: "intake", terminal: true });

		expect(await ingestFetchedIncomingMail(fetched(51, source, { flags: new Set(["\\Seen"]) }), config, { createIntakeSubmission })).toEqual({
			disposition: "skipped",
			route: "intake",
			reason: "already_seen",
	});
		expect(created).toHaveLength(1);
		expect(await MailIngestEntity.get({ mailbox: config.mailbox, uidValidity: config.uidValidity, uid: 51 })).toBeUndefined();
	});

	test("leaves malformed/unpersistable messages retryable and increments ingest attempts", async () => {
		const malformed = { uid: 52 } satisfies FetchedIncomingMail;

		expect(await ingestFetchedIncomingMail(malformed, config)).toMatchObject({
			disposition: "retry",
			reason: "IMAP fetch did not include the RFC 5322 source.",
		});
		expect(await ingestFetchedIncomingMail(malformed, config)).toMatchObject({ disposition: "retry" });
		expect(await MailIngestEntity.get({ mailbox: config.mailbox, uidValidity: config.uidValidity, uid: 52 })).toMatchObject({
			route: "failed",
			terminal: false,
			attempts: 2n,
		});
	});
});
