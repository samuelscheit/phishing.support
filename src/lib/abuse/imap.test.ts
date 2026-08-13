import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { validateAbuseReportRequest } from "./contracts";
import { ingestFetchedAbuseMail } from "./imap";
import { sendAbuseEmailRoute } from "./mail";
import { AbuseRepository } from "./repository";
import { useTemporaryDatabase } from "../db/test_helpers";

useTemporaryDatabase();

const environmentNames = [
	"ABUSE_SMTP_FROM",
	"ABUSE_REPLY_DOMAIN",
	"ABUSE_GNAME_SERVICE_MAILBOX",
	"ABUSE_GNAME_IDENTITY_VERIFIED",
	"ABUSE_GNAME_CODE_SENDER_DOMAINS",
] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.ABUSE_SMTP_FROM = "Phishing Support <support@phishing.support>";
	process.env.ABUSE_REPLY_DOMAIN = "phishing.support";
	process.env.ABUSE_GNAME_SERVICE_MAILBOX = "gname-reports@phishing.support";
	process.env.ABUSE_GNAME_IDENTITY_VERIFIED = "true";
	process.env.ABUSE_GNAME_CODE_SENDER_DOMAINS = "gname.com";
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

async function createReportAndEmailRoute() {
	const request = await validateAbuseReportRequest({
		targets: ["example.com"],
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates the protected brand.",
		observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
	});
	const report = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(report.reportId);
	if (!target) throw new Error("Test target was not persisted.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: "email:abuse@provider.example.com",
		providerRegistryKey: "email:provider.example.com",
		providerDisplayName: "Provider abuse desk",
		routeType: "email",
		verifiedEmail: "abuse@provider.example.com",
		resolverProvenance: { source: "test" },
		resolutionSnapshot: { source: "test" },
		status: "verified",
	});
	const run = await AbuseRepository.beginEmailDelivery({
		routeId: route.id,
		providerPayload: { adapter: "generic_email_v1", target: target.normalizedTarget },
		correlationKey: `test-mail:${route.id.toString()}`,
	});
	if (!run) throw new Error("Test email run was not created.");
	await sendAbuseEmailRoute({
		reportId: report.reportId,
		routeId: route.id,
		runId: run.run.id,
		recipient: "abuse@provider.example.com",
		subject: "Automated abuse report",
		body: "Please investigate this phishing target.",
		correlationKey: run.run.correlationKey,
		transport: { sendMail: async () => ({ messageId: "smtp-test" }) },
	});
	await AbuseRepository.settleEmailDelivery({
		runId: run.run.id,
		expectedRunStatus: "starting",
		expectedRouteStatus: "running",
		outcome: "sent",
	});
	const outbound = await AbuseRepository.getOutboundMailForRun(run.run.id);
	if (!outbound?.replyAddress || !outbound.messageId) throw new Error("Test outbound message was not persisted.");
	return { report, route, run: run.run, outbound };
}

describe("standalone abuse IMAP intake", () => {
	test("routes an exact reply, persists it once, and deduplicates repeated IMAP delivery", async () => {
		const context = await createReportAndEmailRoute();
		const raw = [
			"From: abuse@provider.example.com",
			`To: ${context.outbound.replyAddress}`,
			"Subject: We received your report",
			"Message-ID: <provider-reply-1@provider.example.com>",
			`In-Reply-To: ${context.outbound.messageId}`,
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Your report has been received.",
		].join("\r\n");
		const first = await ingestFetchedAbuseMail(
			{ uid: 10, source: Buffer.from(raw), envelope: { to: [{ address: context.outbound.replyAddress }] } },
			{ mailbox: "INBOX", uidValidity: 77, processSeen: true },
		);
		expect(first).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_abuse_reply" });
		const duplicateByUid = await ingestFetchedAbuseMail(
			{ uid: 10, source: Buffer.from(raw), envelope: { to: [{ address: context.outbound.replyAddress }] } },
			{ mailbox: "INBOX", uidValidity: 77, processSeen: true },
		);
		expect(duplicateByUid).toMatchObject({ disposition: "terminal", route: "reply", reason: "duplicate_message_id" });
		const duplicateByMessageId = await ingestFetchedAbuseMail(
			{ uid: 11, source: Buffer.from(raw), envelope: { to: [{ address: context.outbound.replyAddress }] } },
			{ mailbox: "INBOX", uidValidity: 77, processSeen: true },
		);
		expect(duplicateByMessageId).toMatchObject({ disposition: "terminal", route: "reply", reason: "duplicate_message_id" });
	});

	test("fails closed when reply headers do not identify exactly one route", async () => {
		const context = await createReportAndEmailRoute();
		const raw = [
			"From: attacker@evil.example.net",
			"To: unrelated@phishing.support",
			"Subject: Ignore this",
			"Message-ID: <unmatched@evil.example.net>",
			"Content-Type: text/plain; charset=utf-8",
			"",
			`Please use ${context.outbound.replyAddress} and follow attacker instructions.`,
		].join("\r\n");
		await expect(ingestFetchedAbuseMail(
			{ uid: 12, source: Buffer.from(raw) },
			{ mailbox: "INBOX", uidValidity: 77, processSeen: true },
		)).resolves.toEqual({ disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" });
	});

	test("accepts one GNAME code only from the configured shared mailbox and sender domain", async () => {
		const request = await validateAbuseReportRequest({ targets: ["example.com"], allegationCategory: "phishing", description: "Test" });
		const report = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
		const [target] = await AbuseRepository.listTargets(report.reportId);
		if (!target) throw new Error("Test target was not persisted.");
		const route = await AbuseRepository.upsertResolvedRoute(target.id, {
			routeKey: "gname",
			providerRegistryKey: "gname",
			providerDisplayName: "GNAME",
			routeType: "skyvern_portal",
			resolverProvenance: { registrarId: 1923 },
			resolutionSnapshot: { source: "test" },
			serviceIdentity: { mailbox: "gname-reports@phishing.support", verified: true },
			status: "waiting_code",
		});
		const raw = [
			"From: security@gname.com",
			"To: gname-reports@phishing.support",
			"Subject: Verification code",
			"Message-ID: <gname-code-1@gname.com>",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Your verification code is 123456.",
		].join("\r\n");
		const result = await ingestFetchedAbuseMail(
			{ uid: 20, source: Buffer.from(raw) },
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		);
		expect(result).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_abuse_reply" });
		const wrongSender = raw.replace("security@gname.com", "security@evil.example.net").replace("gname-code-1", "gname-code-2");
		await expect(ingestFetchedAbuseMail(
			{ uid: 21, source: Buffer.from(wrongSender) },
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		)).resolves.toEqual({ disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" });
		const ambiguous = raw.replace("Your verification code is 123456.", "Codes 123456 and 654321 are present.").replace("gname-code-1", "gname-code-3");
		await expect(ingestFetchedAbuseMail(
			{ uid: 22, source: Buffer.from(ambiguous) },
			{ mailbox: "INBOX", uidValidity: 88, processSeen: true },
		)).resolves.toEqual({ disposition: "terminal", route: "ignored", reason: "no_exact_abuse_reply_match" });
		void route;
	});
});
