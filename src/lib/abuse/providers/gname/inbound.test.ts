import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { ingestFetchedAbuseMail } from "../../imap";
import { prepareSkyvernTaskCreation } from "../../persistence/provider_runs";
import { AbuseRepository } from "../../repository";
import { abuseJobs, abuseMailCodes } from "../../schema";
import type { AbuseSkyvernAdapter } from "../../skyvern";
import { GNAME_PROVIDER } from "./definition";
import { deliverGnameVerificationCode } from "./code_delivery";
import { findGnameInboundRoute, onGnameInboundMessageStored } from "./inbound";
import { gnameCodeLockKey, gnameCodeLockOwner } from "./mailbox";
import { prepareVerificationCodeDelivery } from "./persistence/code_delivery";
import { beginGnamePortalExecution } from "./persistence/portal";
import { recordGnameSkyvernTaskStarted } from "./persistence/runs";

useTemporaryDatabase();

const environmentNames = [
	"ABUSE_GNAME_ENABLED",
	"ABUSE_GNAME_IDENTITY_VERIFIED",
	"ABUSE_GNAME_SERVICE_NAME",
	"ABUSE_GNAME_SERVICE_MAILBOX",
	"ABUSE_GNAME_CODE_SENDER_DOMAINS",
] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.ABUSE_GNAME_ENABLED = "true";
	process.env.ABUSE_GNAME_IDENTITY_VERIFIED = "true";
	process.env.ABUSE_GNAME_SERVICE_NAME = "Phishing Support";
	process.env.ABUSE_GNAME_SERVICE_MAILBOX = "gname-reports@phishing.support";
	process.env.ABUSE_GNAME_CODE_SENDER_DOMAINS = "gname.com";
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

async function createGnameRoute(status: "queued" | "waiting_code" = "queued") {
	const request = await validateAbuseReportRequest({
		targets: ["example.com"],
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates the protected brand.",
		observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
		legalBrandUrl: "https://brand.example.com/",
	});
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Test report did not create its target.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: GNAME_PROVIDER.key,
		providerRegistryKey: GNAME_PROVIDER.key,
		providerDisplayName: GNAME_PROVIDER.displayName,
		routeType: "skyvern_portal",
		providerDefinitionVersion: GNAME_PROVIDER.version,
		providerDefinitionHash: GNAME_PROVIDER.contentHash,
		resolverProvenance: { registrarId: 1923, match: "exact_iana_registrar_id" },
		resolutionSnapshot: { source: "test" },
		serviceIdentity: { name: "Phishing Support", mailbox: "gname-reports@phishing.support", verified: true },
		status,
	});
	return { reportId: created.reportId, route };
}

async function createWaitingGnameRun() {
	const context = await createGnameRoute();
	const execution = await beginGnamePortalExecution({
		routeId: context.route.id,
		correlationKey: `portal-run:${context.route.id.toString()}`,
		providerPayload: { adapter: "gname-inbound-test", stage: "evidence_upload_pending" },
		lockKey: gnameCodeLockKey("gname-reports@phishing.support"),
		lockOwner: gnameCodeLockOwner(context.route.id),
		lockLeaseMs: 60_000,
	});
	if (!execution.acquired) throw new Error("Test route did not acquire its GNAME mailbox lease.");
	if (!(await prepareSkyvernTaskCreation(execution.run.id))) throw new Error("Test route did not enter task creation.");
	if (!(await recordGnameSkyvernTaskStarted({ runId: execution.run.id, skyvernRunId: `gname-inbound-${execution.run.id.toString()}` }))) {
		throw new Error("Test route did not enter waiting_code.");
	}
	return { ...context, run: execution.run };
}

const validCandidate = {
	senderAddresses: ["security@gname.com"],
	recipients: ["gname-reports@phishing.support"],
	textBody: "Your GNAME verification code is 123456.",
};

function gnameVerificationMail(overrides: { messageId?: string; inReplyTo?: string; recipient?: string | null; sender?: string; body?: string } = {}): Buffer {
	return Buffer.from([
		`From: ${overrides.sender ?? "security@gname.com"}`,
		...(overrides.recipient === null ? [] : [`To: ${overrides.recipient ?? "gname-reports@phishing.support"}`]),
		"Subject: Verification code",
		`Message-ID: ${overrides.messageId ?? "<gname-code-imap-1@gname.com>"}`,
		...(overrides.inReplyTo ? [`In-Reply-To: ${overrides.inReplyTo}`] : []),
		"Content-Type: text/plain; charset=utf-8",
		"",
		overrides.body ?? validCandidate.textBody,
	].join("\r\n"));
}

describe("GNAME inbound verification-mail routing", () => {
	test("matches only the configured mailbox, allowed sender, one code, and one waiting route", async () => {
		const context = await createWaitingGnameRun();
		expect(await findGnameInboundRoute(validCandidate)).toMatchObject({ id: context.route.id });
		expect(await findGnameInboundRoute({ ...validCandidate, recipients: ["elsewhere@phishing.support"] })).toBeUndefined();
		expect(await findGnameInboundRoute({ ...validCandidate, senderAddresses: ["security@evil.example"] })).toBeUndefined();
		expect(await findGnameInboundRoute({ ...validCandidate, textBody: "Codes 123456 and 654321 are present." })).toBeUndefined();
	});

	test("fails closed when more than one durable GNAME route is waiting for a code", async () => {
		await createWaitingGnameRun();
		await createGnameRoute("waiting_code");
		expect(await findGnameInboundRoute(validCandidate)).toBeUndefined();
	});

	test("routes the generic IMAP fallback through GNAME policy and rejects wrong sender, recipient, and ambiguous code", async () => {
		const context = await createWaitingGnameRun();
		const accepted = await ingestFetchedAbuseMail(
			{ uid: 20, source: gnameVerificationMail() },
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		);
		expect(accepted).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_abuse_reply" });

		const wrongSender = await ingestFetchedAbuseMail(
			{ uid: 21, source: gnameVerificationMail({ messageId: "<gname-code-imap-2@evil.example>", sender: "security@evil.example" }) },
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		);
		expect(wrongSender).toEqual({ disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" });
		const wrongRecipient = await ingestFetchedAbuseMail(
			{ uid: 22, source: gnameVerificationMail({ messageId: "<gname-code-imap-3@gname.com>", recipient: "other@phishing.support" }) },
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		);
		expect(wrongRecipient).toEqual({ disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" });
		const ambiguous = await ingestFetchedAbuseMail(
			{ uid: 23, source: gnameVerificationMail({ messageId: "<gname-code-imap-4@gname.com>", body: "Codes 123456 and 654321 are present." }) },
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		);
		expect(ambiguous).toEqual({ disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" });
		const unresolvedExplicitReply = await ingestFetchedAbuseMail(
			{ uid: 25, source: gnameVerificationMail({ messageId: "<gname-code-imap-5@gname.com>", inReplyTo: "<unknown-outbound@evil.example>" }) },
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		);
		expect(unresolvedExplicitReply).toEqual({ disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" });

		const jobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(and(eq(abuseJobs.routeId, context.route.id), eq(abuseJobs.jobType, "deliver_provider_verification_code")))
			.all();
		expect(jobs).toHaveLength(1);
	});

	test("retains an envelope-only recipient for post-storage GNAME authorization", async () => {
		const context = await createWaitingGnameRun();
		const result = await ingestFetchedAbuseMail(
			{
				uid: 26,
				envelope: { bcc: [{ address: "gname-reports@phishing.support" }] },
				source: gnameVerificationMail({ messageId: "<gname-envelope-code@gname.com>", recipient: null }),
			},
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		);
		expect(result).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_abuse_reply" });
		if (result.disposition !== "terminal" || !result.messageId) throw new Error("Expected the envelope-only code message to be stored.");
		expect(await AbuseRepository.getMailMessage(result.messageId)).toMatchObject({
			routeId: context.route.id,
			toAddresses: ["gname-reports@phishing.support"],
		});
		const jobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(and(eq(abuseJobs.routeId, context.route.id), eq(abuseJobs.jobType, "deliver_provider_verification_code")))
			.all();
		expect(jobs).toHaveLength(1);
	});

	test("gives explicit RFC correlation precedence without authorizing an OTP from the message body", async () => {
		const context = await createWaitingGnameRun();
		const rawArtifactId = await AbuseRepository.saveArtifact({
			reportId: context.reportId,
			routeId: context.route.id,
			runId: context.run.id,
			name: "outbound-correlation.eml",
			kind: "outbound_mail_mime",
			mimeType: "message/rfc822",
			buffer: Buffer.from("outbound"),
		});
		const outboundMessageId = "<gname-outbound-correlation@gname.com>";
		await AbuseRepository.createOutboundMail({
			reportId: context.reportId,
			routeId: context.route.id,
			runId: context.run.id,
			fromAddress: "Phishing Support <support@phishing.support>",
			toAddresses: ["abuse@gname.com"],
			subject: "Automated abuse report",
			textBody: "Please investigate this report.",
			messageId: outboundMessageId,
			replyAddress: "reply-token@phishing.support",
			correlationKey: "gname-explicit-correlation",
			rawArtifactId,
			attachmentArtifactIds: [],
		});
		const result = await ingestFetchedAbuseMail(
			{
				uid: 24,
				source: gnameVerificationMail({ messageId: "<gname-explicit-inbound@gname.com>", inReplyTo: outboundMessageId, recipient: "other@phishing.support" }),
			},
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		);
		expect(result).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_abuse_reply" });
		const jobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(and(eq(abuseJobs.routeId, context.route.id), eq(abuseJobs.jobType, "deliver_provider_verification_code")))
			.all();
		expect(jobs).toHaveLength(0);
	});

	test("revalidates persisted state and queues one route/run-bound generic delivery job", async () => {
		const context = await createWaitingGnameRun();
		const stored = await AbuseRepository.persistInboundMailWithArtifacts({
			reportId: context.reportId,
			routeId: context.route.id,
			kind: "reply",
			fromAddress: "security@gname.com",
			toAddresses: ["gname-reports@phishing.support"],
			textBody: validCandidate.textBody,
			messageId: "<gname-code@gname.com>",
			mailbox: "INBOX",
			uidValidity: 1,
			uid: 1,
			rawMime: { name: "gname-code.eml", buffer: Buffer.from(validCandidate.textBody) },
			attachments: [],
		});
		expect(stored.created).toBeTrue();
		const message = { routeId: context.route.id, reportId: context.reportId, messageId: stored.id };
		await onGnameInboundMessageStored(message);
		await onGnameInboundMessageStored(message);

		const jobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(and(eq(abuseJobs.routeId, context.route.id), eq(abuseJobs.jobType, "deliver_provider_verification_code")))
			.all();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			reportId: context.reportId,
			routeId: context.route.id,
			runId: context.run.id,
			payload: {
				messageId: stored.id.toString(),
			},
		});
	});

	test("cannot bind a waiting GNAME run to an inbound message from another route", async () => {
		const context = await createWaitingGnameRun();
		const foreign = await createGnameRoute();
		const foreignMail = await AbuseRepository.persistInboundMailWithArtifacts({
			reportId: foreign.reportId,
			routeId: foreign.route.id,
			kind: "reply",
			fromAddress: "security@gname.com",
			toAddresses: ["gname-reports@phishing.support"],
			textBody: validCandidate.textBody,
			messageId: "<gname-cross-route-code@gname.com>",
			mailbox: "INBOX",
			uidValidity: 1,
			uid: 30,
			rawMime: { name: "gname-cross-route-code.eml", buffer: Buffer.from(validCandidate.textBody) },
			attachments: [],
		});

		await expect(prepareVerificationCodeDelivery({
			routeId: context.route.id,
			runId: context.run.id,
			mailMessageId: foreignMail.id,
			code: "123456",
			correlationKey: context.run.correlationKey,
		})).rejects.toThrow("not an inbound message for this GNAME route");
		expect(await AbuseRepository.getProviderRun(context.run.id)).toMatchObject({ executionStatus: "waiting_code" });
		const codes = (await getDb())
			.select()
			.from(abuseMailCodes)
			.where(eq(abuseMailCodes.routeId, context.route.id))
			.all();
		expect(codes).toHaveLength(0);
	});

	test("ignores a job-supplied identifier and sends the code only to the durable route mailbox", async () => {
		const context = await createWaitingGnameRun();
		const stored = await AbuseRepository.persistInboundMailWithArtifacts({
			reportId: context.reportId,
			routeId: context.route.id,
			kind: "reply",
			fromAddress: "security@gname.com",
			toAddresses: ["gname-reports@phishing.support"],
			textBody: validCandidate.textBody,
			messageId: "<gname-identifier-override@gname.com>",
			mailbox: "INBOX",
			uidValidity: 1,
			uid: 31,
			rawMime: { name: "gname-identifier-override.eml", buffer: Buffer.from(validCandidate.textBody) },
			attachments: [],
		});
		const sent: Array<{ identifier: string; content: string; taskId: string }> = [];
		await deliverGnameVerificationCode({
			routeId: context.route.id,
			runId: context.run.id,
			payload: {
				messageId: stored.id.toString(),
				totpIdentifier: "attacker-controlled@evil.example",
			},
		}, {
			owner: "gname-inbound-test",
			getAdapter: () => ({
				sendTotpCode: async (params: { identifier: string; content: string; taskId: string }) => {
					sent.push(params);
				},
			} as unknown as AbuseSkyvernAdapter),
			markUnknownExternal: async () => undefined,
		});
		expect(sent).toEqual([{
			identifier: "gname-reports@phishing.support",
			content: "123456",
			taskId: `gname-inbound-${context.run.id.toString()}`,
		}]);
	});

	test("never converts an explicitly correlated but policy-invalid stored message into a GNAME code job", async () => {
		const context = await createWaitingGnameRun();
		const invalidMessages = [
			{ fromAddress: "security@evil.example", toAddresses: ["gname-reports@phishing.support"], textBody: validCandidate.textBody },
			{ fromAddress: "security@gname.com", toAddresses: ["other@phishing.support"], textBody: validCandidate.textBody },
			{ fromAddress: "security@gname.com", toAddresses: ["gname-reports@phishing.support"], textBody: "Codes 123456 and 654321 are present." },
		];
		for (const [index, message] of invalidMessages.entries()) {
			const stored = await AbuseRepository.persistInboundMailWithArtifacts({
				reportId: context.reportId,
				routeId: context.route.id,
				kind: "reply",
				...message,
				messageId: `<gname-invalid-${index}@gname.com>`,
				mailbox: "INBOX",
				uidValidity: 1,
				uid: 10 + index,
				rawMime: { name: `gname-invalid-${index}.eml`, buffer: Buffer.from(message.textBody) },
				attachments: [],
			});
			await onGnameInboundMessageStored({ routeId: context.route.id, reportId: context.reportId, messageId: stored.id });
		}
		const jobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(and(eq(abuseJobs.routeId, context.route.id), eq(abuseJobs.jobType, "deliver_provider_verification_code")))
			.all();
		expect(jobs).toHaveLength(0);
	});

	test("fails closed if current configuration no longer matches the route's durable mailbox", async () => {
		const context = await createWaitingGnameRun();
		const stored = await AbuseRepository.persistInboundMailWithArtifacts({
			reportId: context.reportId,
			routeId: context.route.id,
			kind: "reply",
			fromAddress: "security@gname.com",
			toAddresses: ["gname-reports@phishing.support"],
			textBody: validCandidate.textBody,
			messageId: "<gname-config-drift@gname.com>",
			mailbox: "INBOX",
			uidValidity: 1,
			uid: 20,
			rawMime: { name: "gname-config-drift.eml", buffer: Buffer.from(validCandidate.textBody) },
			attachments: [],
		});
		process.env.ABUSE_GNAME_SERVICE_MAILBOX = "new-shared-mailbox@phishing.support";
		expect(await findGnameInboundRoute(validCandidate)).toBeUndefined();
		await onGnameInboundMessageStored({ routeId: context.route.id, reportId: context.reportId, messageId: stored.id });
		const jobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(and(eq(abuseJobs.routeId, context.route.id), eq(abuseJobs.jobType, "deliver_provider_verification_code")))
			.all();
		expect(jobs).toHaveLength(0);
	});

	test("does not enqueue a code delivery after the route leaves waiting_code", async () => {
		const context = await createWaitingGnameRun();
		const stored = await AbuseRepository.persistInboundMailWithArtifacts({
			reportId: context.reportId,
			routeId: context.route.id,
			kind: "reply",
			fromAddress: "security@gname.com",
			toAddresses: ["gname-reports@phishing.support"],
			textBody: validCandidate.textBody,
			messageId: "<gname-code-state-race@gname.com>",
			mailbox: "INBOX",
			uidValidity: 1,
			uid: 2,
			rawMime: { name: "gname-code-state-race.eml", buffer: Buffer.from(validCandidate.textBody) },
			attachments: [],
		});
		await AbuseRepository.transitionRouteStatus({ routeId: context.route.id, from: "waiting_code", to: "needs_human", data: { reason: "test_state_race" } });
		await onGnameInboundMessageStored({ routeId: context.route.id, reportId: context.reportId, messageId: stored.id });
		const jobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(and(eq(abuseJobs.routeId, context.route.id), eq(abuseJobs.jobType, "deliver_provider_verification_code")))
			.all();
		expect(jobs).toHaveLength(0);
	});
});
