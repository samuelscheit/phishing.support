import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { createAbuseEmailDraft, sendAbuseEmailRoute, type AbuseEmailDraft } from "../mail";
import { AbuseRepository } from "../repository";
import { sendEmail } from "./email";

useTemporaryDatabase();

const originalGenericEmail = process.env.ABUSE_GENERIC_EMAIL_ENABLED;
const originalTrackingTokenSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
const originalAbuseSmtpFrom = process.env.ABUSE_SMTP_FROM;
const originalAbuseReplyDomain = process.env.ABUSE_REPLY_DOMAIN;

beforeEach(() => {
	process.env.ABUSE_TRACKING_TOKEN_SECRET = "01234567890123456789012345678901";
	process.env.ABUSE_GENERIC_EMAIL_ENABLED = "true";
	process.env.ABUSE_SMTP_FROM = "support@phishing.support";
	process.env.ABUSE_REPLY_DOMAIN = "phishing.support";
});

afterAll(() => {
	if (originalGenericEmail === undefined) delete process.env.ABUSE_GENERIC_EMAIL_ENABLED;
	else process.env.ABUSE_GENERIC_EMAIL_ENABLED = originalGenericEmail;
	if (originalTrackingTokenSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalTrackingTokenSecret;
	if (originalAbuseSmtpFrom === undefined) delete process.env.ABUSE_SMTP_FROM;
	else process.env.ABUSE_SMTP_FROM = originalAbuseSmtpFrom;
	if (originalAbuseReplyDomain === undefined) delete process.env.ABUSE_REPLY_DOMAIN;
	else process.env.ABUSE_REPLY_DOMAIN = originalAbuseReplyDomain;
});

async function setupRoute() {
	const request = await validateAbuseReportRequest({
		targets: ["example.com"],
		allegationCategory: "phishing",
		description: "A long analyst report that must never be copied verbatim into a provider email. It identifies a credential collection page and includes many forensic details.",
		observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
	});
	const created = await AbuseRepository.createReport({ request, reporter: {} });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Target was not created.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: "email:abuse@provider.example",
		providerRegistryKey: "email:provider.example",
		providerDisplayName: "Provider Abuse Desk",
		routeType: "email",
		verifiedEmail: "abuse@provider.example",
		resolverProvenance: { source: "test" },
		resolutionSnapshot: { registrar: { identity: { organization: "Provider Example LLC" } } },
		status: "verified",
	});
	return { created, route };
}

describe("standalone email worker draft boundary", () => {
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
