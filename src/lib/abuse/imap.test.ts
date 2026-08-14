import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../db";
import { validateAbuseReportRequest } from "./contracts";
import { ingestFetchedAbuseMail } from "./imap";
import { sendAbuseEmailRoute } from "./mail";
import { AbuseRepository } from "./repository";
import { abuseJobs } from "./schema";
import { useTemporaryDatabase } from "../db/test_helpers";

useTemporaryDatabase();

const environmentNames = [
	"ABUSE_SMTP_FROM",
	"ABUSE_REPLY_DOMAIN",
] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.ABUSE_SMTP_FROM = "Phishing Support <support@phishing.support>";
	process.env.ABUSE_REPLY_DOMAIN = "phishing.support";
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
		if (first.disposition !== "terminal" || !first.messageId) throw new Error("Expected the first inbound reply to be stored.");
		const classifierJobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(eq(abuseJobs.dedupeKey, `classify-abuse-mail:${first.messageId.toString()}`))
			.all();
		expect(classifierJobs).toHaveLength(1);
		expect(classifierJobs[0]).toMatchObject({
			jobType: "classify_provider_reply",
			reportId: context.report.reportId,
			routeId: context.route.id,
			status: "queued",
		});
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

	test("repairs a duplicate inbound message left without a classifier by an interrupted older delivery", async () => {
		const context = await createReportAndEmailRoute();
		const replyAddress = context.outbound.replyAddress;
		const outboundMessageId = context.outbound.messageId;
		if (!replyAddress || !outboundMessageId) throw new Error("Test outbound message lost its reply correlation.");
		const messageId = "<provider-reply-recovery@provider.example.com>";
		const raw = [
			"From: abuse@provider.example.com",
			`To: ${replyAddress}`,
			"Subject: Recovery reply",
			`Message-ID: ${messageId}`,
			`In-Reply-To: ${outboundMessageId}`,
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Your report has been received.",
		].join("\r\n");
		const persisted = await AbuseRepository.persistInboundMailWithArtifacts({
			reportId: context.report.reportId,
			routeId: context.route.id,
			kind: "reply",
			fromAddress: "abuse@provider.example.com",
			toAddresses: [replyAddress],
			subject: "Recovery reply",
			textBody: "Your report has been received.",
			messageId,
			inReplyTo: outboundMessageId,
			mailbox: "INBOX",
			uidValidity: 77,
			uid: 19,
			rawMime: { name: "recovery-reply.eml", buffer: Buffer.from(raw) },
			attachments: [],
		});
		expect(persisted.created).toBeTrue();
		const db = await getDb();
		const classifierDedupeKey = `classify-abuse-mail:${persisted.id.toString()}`;
		expect(db.select().from(abuseJobs).where(eq(abuseJobs.dedupeKey, classifierDedupeKey)).all()).toHaveLength(1);
		// Simulate a database left by an older interrupted deployment, where the
		// message survived but its separate classifier enqueue did not.
		db.delete(abuseJobs).where(eq(abuseJobs.dedupeKey, classifierDedupeKey)).run();

		const replay = await ingestFetchedAbuseMail(
			{ uid: 20, source: Buffer.from(raw), envelope: { to: [{ address: replyAddress }] } },
			{ mailbox: "INBOX", uidValidity: 77, processSeen: true },
		);
		expect(replay).toMatchObject({ disposition: "terminal", route: "reply", reason: "duplicate_message_id", messageId: persisted.id });
		const recoveredJobs = (await getDb())
			.select()
			.from(abuseJobs)
			.where(eq(abuseJobs.dedupeKey, classifierDedupeKey))
			.all();
		expect(recoveredJobs).toHaveLength(1);
		expect(recoveredJobs[0]).toMatchObject({ jobType: "classify_provider_reply", status: "queued" });
	});

	test("rejects inbound persistence when a route is paired with another report", async () => {
		const first = await createReportAndEmailRoute();
		const second = await createReportAndEmailRoute();
		await expect(AbuseRepository.persistInboundMailWithArtifacts({
			reportId: second.report.reportId,
			routeId: first.route.id,
			kind: "reply",
			fromAddress: "abuse@provider.example.com",
			toAddresses: [first.outbound.replyAddress!],
			messageId: "<cross-report-inbound@provider.example.com>",
			mailbox: "INBOX",
			uidValidity: 77,
			uid: 90,
			rawMime: { name: "cross-report-inbound.eml", buffer: Buffer.from("inbound") },
			attachments: [],
		})).rejects.toThrow("route does not belong to the supplied report");
		expect(await AbuseRepository.getInboundMailByImap({ mailbox: "INBOX", uidValidity: 77, uid: 90 })).toBeUndefined();
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

});
