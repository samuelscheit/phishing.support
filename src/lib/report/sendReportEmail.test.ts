import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
	ArtifactsEntity,
	ProviderReportsEntity,
	ReportMessagesEntity,
	ReportThreadsEntity,
	ReportingSummaryEntity,
	SubmissionsEntity,
} from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { getSubmissionDetails } from "../submissions/details";
import { sendReportEmail } from "./sendReportEmail";

useTemporaryDatabase();

const originalEnvironment = {
	SMTP_FROM: process.env.SMTP_FROM,
	REPORT_REPLY_DOMAIN: process.env.REPORT_REPLY_DOMAIN,
	IMAP_LISTEN_ADDRESS: process.env.IMAP_LISTEN_ADDRESS,
};

beforeEach(() => {
	process.env.SMTP_FROM = "Phishing Support <support@phishing.support>";
	process.env.REPORT_REPLY_DOMAIN = "phishing.support";
	process.env.IMAP_LISTEN_ADDRESS = "report@phishing.support";
});

afterAll(() => {
	for (const [name, value] of Object.entries(originalEnvironment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

async function createSubmission(dedupeKey: string) {
	return SubmissionsEntity.create({
		kind: "website",
		data: { kind: "website", website: { url: `https://${dedupeKey}.example.test/report` } },
		dedupeKey,
	});
}

describe("sendReportEmail", () => {
	test("creates a pending thread and message before SMTP, sends canonical MIME, and retains all artifacts", async () => {
		const submissionId = await createSubmission("outbound-lifecycle");
		let captured: { raw: Buffer; envelope: { from: string; to: string[] } } | undefined;
		let pendingStateObserved = false;

		const result = await sendReportEmail({
			submissionId,
			analysisRunId: 123n,
			draft: {
				to: "Registry Abuse <ABUSE@Example.TEST>",
				subject: "Phishing report",
				body: "Please investigate this phishing URL.",
			},
			attachments: [{ filename: "evidence.txt", content: Buffer.from("captured evidence"), contentType: "text/plain" }],
			data: { url: "https://phish.example.test" },
			transport: {
				sendMail: async (options) => {
					captured = options;
					const threads = await ReportThreadsEntity.listForSubmission(submissionId);
					expect(threads).toHaveLength(1);
					const messages = await ReportMessagesEntity.listForThread(threads[0]!.id);
					expect(messages).toHaveLength(1);
					expect(threads[0]!.status).toBe("pending");
					expect(messages[0]!.status).toBe("pending");
					pendingStateObserved = true;
					return { messageId: "smtp-provider-id-1" };
				},
			},
		});

		expect(pendingStateObserved).toBeTrue();
		expect(result.deliveryStatus).toBe("sent");
		expect(result.replyAddress).toMatch(/^case-[a-f0-9]{32}@phishing\.support$/);
		expect(result.rfcMessageId).toMatch(/^<report-[a-f0-9]{32}@phishing\.support>$/);
		expect(result.providerMessageId).toBe("smtp-provider-id-1");
		expect(captured?.envelope).toEqual({ from: "support@phishing.support", to: ["abuse@example.test"] });

		const raw = captured!.raw.toString("utf-8");
		expect(raw).toContain("From: Phishing Support <support@phishing.support>");
		expect(raw).toContain(`Reply-To: ${result.replyAddress}`);
		expect(raw).toContain(`Message-ID: ${result.rfcMessageId}`);
		expect(raw).toMatch(/X-Phishing-Report-Thread: [a-f0-9]{32}/i);
		expect(raw).toContain("Please investigate this phishing URL.");

		const thread = await ReportThreadsEntity.get(result.threadId);
		const [message] = await ReportMessagesEntity.listForThread(result.threadId);
		expect(thread?.status).toBe("sent");
		expect(thread?.analysisRunId).toBe(123n);
		expect(thread?.replyAddress).toBe(result.replyAddress);
		expect(message).toMatchObject({
			id: result.messageId,
			direction: "outbound",
			kind: "report",
			status: "sent",
			messageId: result.rfcMessageId,
			providerMessageId: "smtp-provider-id-1",
			to: ["abuse@example.test"],
		});
		expect(message?.sentAt).toBeInstanceOf(Date);
		expect(message?.rawArtifactId).toBeDefined();
		expect(message?.attachmentArtifactIds).toHaveLength(1);

		const rawArtifact = await ArtifactsEntity.get(message!.rawArtifactId!);
		const attachmentArtifact = await ArtifactsEntity.get(BigInt(message!.attachmentArtifactIds[0]!));
		expect(rawArtifact?.blob.equals(captured!.raw)).toBeTrue();
		expect(rawArtifact).toMatchObject({ submissionId, kind: "report_eml", mimeType: "message/rfc822" });
		expect(attachmentArtifact?.blob.toString()).toBe("captured evidence");
		expect(attachmentArtifact).toMatchObject({ submissionId, kind: "report_attachment", name: "evidence.txt" });
		expect(await ReportingSummaryEntity.hasSuccessfulReport(submissionId)).toBeTrue();
	});

	test("gives every SMTP target on the same submission a distinct opaque reply identity", async () => {
		const submissionId = await createSubmission("distinct-identities");
		const transport = { sendMail: async () => ({ messageId: "provider-id" }) };

		const [first, second] = await Promise.all([
			sendReportEmail({
				submissionId,
				draft: { to: "first@example.test", subject: "First report", body: "First body" },
				transport,
			}),
			sendReportEmail({
				submissionId,
				draft: { to: "second@example.test", subject: "Second report", body: "Second body" },
				transport,
			}),
		]);

		expect(first.deliveryStatus).toBe("sent");
		expect(second.deliveryStatus).toBe("sent");
		expect(first.replyAddress).not.toBe(second.replyAddress);
		expect(first.rfcMessageId).not.toBe(second.rfcMessageId);
		expect((await ReportThreadsEntity.listForSubmission(submissionId)).map((thread) => thread.replyAddress)).toEqual(
			expect.arrayContaining([first.replyAddress, second.replyAddress]),
		);
	});

	test("keeps SMTP failures visible without classifying the submission as reported", async () => {
		const submissionId = await createSubmission("smtp-failure");
		const result = await sendReportEmail({
			submissionId,
			draft: { to: "abuse@example.test", subject: "Failure path", body: "The transport should fail." },
			transport: { sendMail: async () => Promise.reject(new Error("SMTP unavailable")) },
		});

		expect(result).toMatchObject({ deliveryStatus: "failed", error: "SMTP unavailable" });
		const thread = await ReportThreadsEntity.get(result.threadId);
		const [message] = await ReportMessagesEntity.listForThread(result.threadId);
		expect(thread?.status).toBe("failed");
		expect(message).toMatchObject({ status: "failed", error: "SMTP unavailable" });
		expect(await ReportingSummaryEntity.hasSuccessfulReport(submissionId)).toBeFalse();
		expect((await SubmissionsEntity.get(submissionId))?.status).toBe("new");
	});

	test("does not let a later SMTP settlement overwrite a reply received while transport is pending", async () => {
		const submissionId = await createSubmission("pending-reply-race");
		const result = await sendReportEmail({
			submissionId,
			draft: { to: "abuse@example.test", subject: "Race", body: "Race body" },
			transport: {
				sendMail: async () => {
					const [thread] = await ReportThreadsEntity.listForSubmission(submissionId);
					expect(thread?.status).toBe("pending");
					await ReportMessagesEntity.persistInboundWithIngest({
						threadId: thread!.id,
						kind: "reply",
						from: "Abuse Desk <abuse@example.test>",
						to: [thread!.replyAddress],
						subject: "Case received",
						textBody: "We received the report.",
						messageId: "<inbound-race@example.test>",
						mailbox: "INBOX",
						uidValidity: 99,
						uid: 1,
						rawMessageId: "<inbound-race@example.test>",
					});
					return { messageId: "smtp-provider-race" };
				},
			},
		});

		expect(result.deliveryStatus).toBe("sent");
        const thread = await ReportThreadsEntity.get(result.threadId);
        const messages = await ReportMessagesEntity.listForThread(result.threadId);
		expect(thread?.status).toBe("replied");
		expect(messages.map((message) => message.direction)).toEqual(["outbound", "inbound"]);
		expect(messages.find((message) => message.direction === "outbound")).toMatchObject({ status: "sent", sentAt: expect.any(Date) });
        expect(messages.find((message) => message.direction === "inbound")?.status).toBe("received");
	});

	test("does not expose thread tokens, private data, raw blobs, or provider implementation data in submission details", async () => {
		const submissionId = await createSubmission("public-details");
		const created = await ReportThreadsEntity.createWithPendingOutbound({
			submissionId,
			to: ["abuse@example.test"],
			subject: "Private thread",
			replyAddress: "case-11111111111111111111111111111111@phishing.support",
			replyToken: "11111111111111111111111111111111",
			data: { secretThreadContext: "do-not-expose" },
			from: "support@phishing.support",
			textBody: "Thread body",
			rfcMessageId: "<public-details-outbound@example.test>",
		});
		await ProviderReportsEntity.create({
			submissionId,
			channel: "provider_test",
			to: "Provider",
			body: "Provider report",
			data: { privateProviderContext: "do-not-expose" },
		});

		const details = await getSubmissionDetails(submissionId.toString());
		const serialized = JSON.stringify(details);
		expect(details?.reportThreads[0]).toMatchObject({ id: created.threadId, replyAddress: "case-11111111111111111111111111111111@phishing.support" });
		expect(Object.keys(details!.reportThreads[0]!)).not.toContain("replyToken");
		expect(Object.keys(details!.providerReports[0]!)).not.toContain("data");
		expect(Object.keys(details!.providerReports[0]!)).not.toContain("submissionId");
		expect(serialized).not.toContain("11111111111111111111111111111111\"");
		expect(serialized).not.toContain("secretThreadContext");
		expect(serialized).not.toContain("privateProviderContext");
	});
});
