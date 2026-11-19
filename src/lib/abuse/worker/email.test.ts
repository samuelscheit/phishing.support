import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { createAbuseEmailDraft, type AbuseEmailDraft } from "../mail/draft";
import { sendAbuseEmailRoute } from "../mail/send";
import { AbuseRepository } from "../repository";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { emailRoute } from "../resolver/routes";
import { reportConfirmedEmailPhishing } from "../submission_reports";
import { sendEmail } from "./email";
import { resolveReport } from "./resolution";

useTemporaryDatabase();

const originalAbuseSmtpFrom = process.env.SMTP_FROM;
const originalAbuseReplyDomain = process.env.REPLY_DOMAIN;

beforeEach(() => {
	process.env.SMTP_FROM = "support@phishing.support";
	process.env.REPLY_DOMAIN = "phishing.support";
});

afterAll(() => {
	if (originalAbuseSmtpFrom === undefined) delete process.env.SMTP_FROM;
	else process.env.SMTP_FROM = originalAbuseSmtpFrom;
	if (originalAbuseReplyDomain === undefined) delete process.env.REPLY_DOMAIN;
	else process.env.REPLY_DOMAIN = originalAbuseReplyDomain;
});

async function setupRoute(recipient = "abuse@provider.example") {
	const request = await validateAbuseReportRequest({
		targets: ["example.com"],
		allegationCategory: "phishing",
		reporterName: "Test Reporter",
		reporterContactEmail: "reporter@example.org",
		description: "A long analyst report that must never be copied verbatim into a provider email. It identifies a credential collection page and includes many forensic details.",
		observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
	});
	const created = await AbuseRepository.createReport({ request, reporter: {} });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Target was not created.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: `email:${recipient}`,
		providerRegistryKey: `email:${recipient.split("@")[1]}`,
		providerDisplayName: "Provider Abuse Desk",
		routeType: "email",
		verifiedEmail: recipient,
		resolverProvenance: { source: "test" },
		resolutionSnapshot: { registrar: { identity: { organization: "Provider Example LLC" } } },
		status: "verified",
	});
	return { created, route };
}

describe("attached phishing mail", () => {
	async function sentAttachments(recipient: string, options: { attachedMessagesAsText?: boolean } = {}) {
		const { created, route } = await setupRoute(recipient);
		await AbuseRepository.saveArtifact({ reportId: created.reportId, routeId: route.id, name: "phishing-email.eml", kind: "referral_attachment", mimeType: "message/rfc822", buffer: Buffer.from("Subject: lure\r\n\r\nhttps://login.example.com/collect") });
		await AbuseRepository.saveArtifact({ reportId: created.reportId, routeId: route.id, name: "website.png", kind: "referral_attachment", mimeType: "image/png", buffer: Buffer.from("png") });
		const sent: Array<{ filename: string; mimeType: string }> = [];
		const names: string[][] = [];
		await sendEmail(route.id, {
			markUnknownExternal: async () => undefined,
			createDraft: async (input) => {
				names.push(input.attachmentNames ?? []);
				return { subject: "[Phishing Support] Abuse report for example.com", body: "Hello,\n\nA report.\n\nRegards,\nThe phishing.support team", recipientLabel: "Provider" };
			},
			send: async (params) => {
				sent.push(...(params.attachments ?? []).map(({ filename, mimeType }) => ({ filename, mimeType })));
				return { messageId: 998n, status: "sent", rfcMessageId: "<attachments@phishing.support>" };
			},
		}, options);
		return { sent: sent.sort((a, b) => a.filename.localeCompare(b.filename)), names: names.flat().sort() };
	}

	test("goes as an attached message to an ordinary mailbox", async () => {
		expect((await sentAttachments("abuse@provider.example")).sent).toEqual([{ filename: "phishing-email.eml", mimeType: "message/rfc822" }, { filename: "website.png", mimeType: "image/png" }]);
	});

	test("goes as text to a server known to refuse attached messages, and the draft names the text file", async () => {
		const { sent, names } = await sentAttachments("abuse@hostzealot.com");
		expect(sent).toEqual([{ filename: "phishing-email.eml.txt", mimeType: "text/plain" }, { filename: "website.png", mimeType: "image/png" }]);
		expect(names).toEqual(["phishing-email.eml.txt", "website.png"]);
	});

	test("goes as text on the resend after a server refused it", async () => {
		expect((await sentAttachments("abuse@provider.example", { attachedMessagesAsText: true })).sent[0]).toEqual({ filename: "phishing-email.eml.txt", mimeType: "text/plain" });
	});
});

describe("email worker draft boundary", () => {
	test("persists and sends the provider-facing draft rather than the stored analysis", async () => {
		const { created, route } = await setupRoute();
		const draft: AbuseEmailDraft = {
			subject: "[Phishing Support] Abuse report for example.com",
			body: "Hello Provider Example LLC Abuse Team,\n\nThis is a concise recipient-specific report.\n\nRegards,\nThe phishing.support team",
			recipientLabel: "Provider Example LLC",
		};
		let sent: { subject: string; body: string } | undefined;
		await sendEmail(route.id, {
			markUnknownExternal: async () => undefined,
			createDraft: async () => draft,
			send: async (params) => {
				sent = { subject: params.subject, body: params.body };
				return { messageId: 999n, status: "sent", rfcMessageId: "<test@phishing.support>" };
			},
		});

		expect(sent).toEqual({ subject: draft.subject, body: draft.body });
		const [run] = await AbuseRepository.listProviderRunsForReport(created.reportId);
		expect(run?.providerPayload).toMatchObject({
			kind: "verified_email_report",
			version: 2,
			email: draft,
		});
		expect(run?.providerPayload).not.toHaveProperty("description");
		expect(JSON.stringify(run?.providerPayload)).not.toContain("A long analyst report");
	});

	test("hands the personalized draft to the canonical MIME/SMTP boundary", async () => {
		const { created, route } = await setupRoute();
		let rawMime: string | undefined;
		await sendEmail(route.id, {
			markUnknownExternal: async () => undefined,
			createDraft: async (input) => createAbuseEmailDraft(input, { generateSummary: async () => "The captured page impersonates a trusted service and requests credentials." }),
			send: async (params) => sendAbuseEmailRoute({
				...params,
				transport: {
					sendMail: async ({ raw }) => {
						rawMime = raw.toString("utf8");
						return { messageId: "smtp-provider-draft-boundary" };
					},
				},
			}),
		});

		expect(rawMime).toContain("Hello Provider Example LLC Abuse Team,");
		expect(rawMime).toContain("The captured page impersonates a trusted service");
		expect(rawMime).not.toContain("A long analyst report that must never be copied");
		expect(rawMime).not.toContain("## Verdict");
		expect(await AbuseRepository.getReport(created.reportId)).toMatchObject({ status: "waiting_provider" });
	});

	test("uses the immutable stored draft on a safe delivery retry instead of generating a new one", async () => {
		const { created, route } = await setupRoute();
		const firstDraft: AbuseEmailDraft = {
			subject: "[Phishing Support] Abuse report for example.com",
			body: "Hello Provider Example LLC Abuse Team,\n\nFirst immutable draft.\n\nRegards,\nThe phishing.support team",
			recipientLabel: "Provider Example LLC",
		};
		let createCalls = 0;
		let attempt = 0;
		const sentBodies: string[] = [];
		const services = {
			markUnknownExternal: async () => undefined,
			createDraft: async () => {
				createCalls += 1;
				return firstDraft;
			},
			send: async (params: { body: string; runId: bigint; reportId: bigint; routeId: bigint; recipient: string; subject: string; correlationKey: string; replyAddress?: string }) => {
				attempt += 1;
				sentBodies.push(params.body);
				if (attempt === 1) {
					const messageId = await AbuseRepository.createOutboundMail({
						reportId: params.reportId,
						routeId: params.routeId,
						runId: params.runId,
						fromAddress: "support@phishing.support",
						toAddresses: [params.recipient],
						subject: params.subject,
						textBody: params.body,
						messageId: "<first@phishing.support>",
						replyAddress: "abuse-retry@phishing.support",
						correlationKey: params.correlationKey,
						rawArtifactId: 1n,
						attachmentArtifactIds: [],
					});
					await AbuseRepository.settleOutboundMail({ messageId, status: "failed", error: "recipient rejected" });
					return { messageId, status: "failed" as const, error: "recipient rejected", rfcMessageId: "<first@phishing.support>" };
				}
				return { messageId: 1001n, status: "sent" as const, rfcMessageId: "<retry@phishing.support>" };
			},
		};

		await expect(sendEmail(route.id, services)).rejects.toThrow("recipient rejected");
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "delivery_failed" });
		await sendEmail(route.id, services);
		expect(createCalls).toBe(1);
		expect(sentBodies).toEqual([firstDraft.body, firstDraft.body]);
		expect(await AbuseRepository.getReport(created.reportId)).toMatchObject({ status: "waiting_provider" });
	});

	test("the resend after our relay refused the report is drafted anew, live URLs included", async () => {
		const { created, route } = await setupRoute();
		// The refused draft predates the case tag and the hosting address; the provider never saw it.
		const refused: AbuseEmailDraft = {
			subject: "[Phishing Support] Abuse report for example.com",
			body: "Hello Provider Example LLC Abuse Team,\n\nObserved URLs:\n- https://login.example.com/collect\n\nRegards,\nThe phishing.support team",
			recipientLabel: "Provider Example LLC",
		};
		const current: AbuseEmailDraft = {
			subject: "[Phishing Support] [PS-0123456789ab] Abuse report for example.com",
			body: "Hello Provider Example LLC Abuse Team,\n\nTarget: example.com\nHosting IP address: 192.0.2.10 (example.com resolved to 192.0.2.10 on 2026-11-19)\nObserved URLs:\n- https://login.example.com/collect\n\nRegards,\nThe phishing.support team",
			recipientLabel: "Provider Example LLC",
		};
		const drafts = [refused, current];
		const sentBodies: string[] = [];
		const sentSubjects: string[] = [];
		const services = {
			markUnknownExternal: async () => undefined,
			createDraft: async () => drafts.shift()!,
			send: async (params: { body: string; runId: bigint; reportId: bigint; routeId: bigint; recipient: string; subject: string; correlationKey: string }) => {
				sentBodies.push(params.body);
				sentSubjects.push(params.subject);
				if (sentBodies.length > 1) return { messageId: 1002n, status: "sent" as const, rfcMessageId: "<resend@phishing.support>" };
				const messageId = await AbuseRepository.createOutboundMail({
					reportId: params.reportId, routeId: params.routeId, runId: params.runId, fromAddress: "support@phishing.support", toAddresses: [params.recipient],
					subject: params.subject, textBody: params.body, messageId: "<refused@phishing.support>", replyAddress: "abuse-relay@phishing.support",
					correlationKey: params.correlationKey, rawArtifactId: 1n, attachmentArtifactIds: [],
				});
				await AbuseRepository.settleOutboundMail({ messageId, status: "failed", error: "550 5.7.1 [CS101] Message rejected due to local policy" });
				return { messageId, status: "failed" as const, error: "550 5.7.1 [CS101] Message rejected due to local policy", rfcMessageId: "<refused@phishing.support>" };
			},
		};
		await expect(sendEmail(route.id, services)).rejects.toThrow("CS101");
		await sendEmail(route.id, services, { redraft: true });
		expect(drafts).toEqual([]);
		expect(sentSubjects).toEqual([refused.subject, current.subject]);
		expect(sentBodies[1]).toContain("Hosting IP address: 192.0.2.10");
		// The run now holds the draft that was sent, for any later retry.
		const run = await AbuseRepository.getProviderRunByCorrelationKey(`email-run:${route.id.toString()}`);
		expect((run!.providerPayload as { email: AbuseEmailDraft }).email).toEqual(current);
		expect(sentBodies[0]).toContain("https://login.example.com/collect");
		expect(sentBodies[1]).toContain("- https://login.example.com/collect\n");
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "awaiting_provider_reply" });
	});

	test("fails closed instead of completing a stale job while an email route is still running", async () => {
		const { created, route } = await setupRoute();
		const draft: AbuseEmailDraft = {
			subject: "[Phishing Support] Abuse report for example.com",
			body: "Hello Provider Example LLC Abuse Team,\n\nA durable draft.",
			recipientLabel: "Provider Example LLC",
		};
		const execution = await AbuseRepository.beginEmailDelivery({
			routeId: route.id,
			providerPayload: {
				kind: "verified_email_report",
				version: 2,
				target: "example.com",
				observedUrls: ["https://login.example.com/collect"],
				recipient: "abuse@provider.example",
				email: draft,
			},
			correlationKey: `email-run:${route.id.toString()}`,
		});
		if (!execution) throw new Error("The test email route could not be claimed.");
		await expect(sendEmail(route.id, {
			markUnknownExternal: async (params) => AbuseRepository.markUnknownExternalState(params),
		})).rejects.toThrow("delivery reconciliation is required");
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "unknown_external_state" });
		expect(await AbuseRepository.getProviderRun(execution.run.id)).toMatchObject({ executionStatus: "unknown_external_state" });
		expect(await AbuseRepository.getReport(created.reportId)).toMatchObject({ status: "failed" });
	});
});

describe("email submission reporting", () => {
	test("resolves the sending IP to its abuse contact and mails it the phishing message with an email-specific draft", async () => {
		const submissionId = 372818777718394942n;
		await SubmissionsEntity.create({ id: submissionId, kind: "email", data: { kind: "email" }, dedupeKey: "email-worker-sending-ip" });
		const eml = "From: Wallet <notice@express.example.com>\r\nTo: [redacted]\r\nSubject: Verify\r\n\r\nVerify your wallet.";
		const created = await reportConfirmedEmailPhishing({ submissionId, analysisText: "The email impersonates a wallet provider.", redactedEml: eml, sendingIp: "199.102.178.225", reporter: {} });

		await resolveReport(created.reportId, async (target) => target.targetType === "ip"
			? {
				status: "resolved",
				resolverSnapshot: { source: "test" },
				routes: [emailRoute({ email: "abuse@medallia.com", providerName: "Medallia", provenance: { source: "ip_rdap" }, snapshot: { allocationOwner: { organization: "Medallia, Inc." } } })],
			}
			: { status: "no_route", disposition: "no_mail_report_provider", resolverSnapshot: {}, routes: [] });
		const routes = await AbuseRepository.listRoutes(created.reportId);
		const mailRoute = routes.find((route) => route.routeType === "email");
		expect(mailRoute).toMatchObject({ verifiedEmail: "abuse@medallia.com", status: "verified" });

		let sent: { attachments: Array<{ filename: string; mimeType: string; content: Buffer }>; body: string } | undefined;
		await sendEmail(mailRoute!.id, {
			markUnknownExternal: async () => undefined,
			createDraft: async (input) => createAbuseEmailDraft(input, { generateSummary: async () => "The email impersonates a wallet provider and links to a credential page." }),
			send: async (params) => {
				sent = { attachments: params.attachments ?? [], body: params.body };
				return { messageId: 1n, status: "sent", rfcMessageId: "<sent@phishing.support>" };
			},
		});
		expect(sent?.attachments.map((attachment) => [attachment.filename, attachment.mimeType])).toEqual([["phishing-email.eml", "message/rfc822"]]);
		expect(sent?.attachments[0]?.content.toString()).toBe(eml);
		expect(sent?.body).toContain("reporting a phishing email that was sent from 199.102.178.225 to Medallia, Inc.");
		expect(sent?.body).toContain(`Case details: https://phishing.support/submissions/${submissionId.toString()}`);
	});
});
