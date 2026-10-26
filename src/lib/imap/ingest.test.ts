import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../db";
import { MailIngestEntity, SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { sendAbuseEmailRoute } from "../abuse/mail";
import { AbuseRepository } from "../abuse/repository";
import { abuseJobs } from "../abuse/schema";
import { ingestFetchedMail, type MailIngestConfig } from "./ingest";
import type { FetchedMail } from "./rfc";

useTemporaryDatabase();

const config: MailIngestConfig = { mailbox: "phishing.report", uidValidity: 73, intakeAddress: "report@phishing.support" };
const environmentNames = ["SMTP_FROM", "REPLY_DOMAIN"] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.SMTP_FROM = "Phishing Support <support@phishing.support>";
	process.env.REPLY_DOMAIN = "phishing.support";
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

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

function fetched(uid: number, source: Buffer, options: Partial<FetchedMail> = {}): FetchedMail {
	return { uid, source, internalDate: new Date("2026-08-13T12:00:00.000Z"), ...options };
}

const noIntake = async () => {
	throw new Error("Intake must not run for this message.");
};

/** A sent abuse email whose Reply-To and Message-ID identify exactly one route. */
async function sentReport(target = "example.com") {
	const request = await validateAbuseReportRequest({
		targets: [target],
		allegationCategory: "phishing",
		reporterName: "Test Reporter",
		reporterContactEmail: "reporter@example.org",
		description: "A credential-harvesting page impersonates the protected brand.",
		observedUrls: [{ target, urls: [`https://login.${target}/collect`] }],
	});
	const report = await AbuseRepository.createReport({ request, reporter: {} });
	const [reportTarget] = await AbuseRepository.listTargets(report.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(reportTarget!.id, {
		routeKey: `email:abuse@provider.${target}`,
		providerRegistryKey: `email:provider.${target}`,
		providerDisplayName: "Provider abuse desk",
		routeType: "email",
		verifiedEmail: `abuse@provider.${target}`,
		resolverProvenance: { source: "test" },
		resolutionSnapshot: { source: "test" },
		status: "verified",
	});
	const delivery = await AbuseRepository.beginEmailDelivery({ routeId: route.id, providerPayload: { source: "test" }, correlationKey: `test-mail:${route.id.toString()}` });
	if (!delivery) throw new Error("Test email run was not created.");
	await sendAbuseEmailRoute({
		reportId: report.reportId,
		routeId: route.id,
		runId: delivery.run.id,
		recipient: `abuse@provider.${target}`,
		subject: "Automated abuse report",
		body: "Please investigate this phishing target.",
		correlationKey: delivery.run.correlationKey,
		transport: { sendMail: async () => ({ messageId: "smtp-test" }) },
	});
	await AbuseRepository.settleEmailDelivery({ runId: delivery.run.id, expectedRunStatus: "starting", expectedRouteStatus: "running", outcome: "sent" });
	const outbound = await AbuseRepository.getOutboundMailForRun(delivery.run.id);
	if (!outbound?.replyAddress || !outbound.messageId) throw new Error("Test outbound message was not persisted.");
	return { report, route, replyAddress: outbound.replyAddress, outboundMessageId: outbound.messageId };
}

async function inboundMessages(reportId: bigint) {
	return (await AbuseRepository.listMailForReport(reportId)).filter((message) => message.direction === "inbound");
}

describe("mailbox ingest", () => {
	test("stores an already-seen provider reply by its Reply-To identity with raw MIME, attachment, and one classifier job", async () => {
		const sent = await sentReport();
		const source = eml({
			From: "Abuse Desk <abuse@provider.example.com>",
			To: `Generated Address <${sent.replyAddress.toUpperCase()}>`,
			"Message-ID": "<reply-one@provider.example.com>",
			Subject: "Case received",
		}, "We have received your report.", [{ filename: "case-note.txt", content: "Ticket #123" }]);

		const result = await ingestFetchedMail(fetched(44, source, { flags: new Set(["\\Seen"]) }), config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_provider_reply" });
		if (result.disposition !== "terminal" || !result.messageId) throw new Error("Expected a stored reply.");

		const stored = await AbuseRepository.getMailMessage(result.messageId);
		expect(stored).toMatchObject({ routeId: sent.route.id, direction: "inbound", status: "received", messageId: "<reply-one@provider.example.com>" });
		expect(stored?.textBody).toContain("We have received your report.");
		expect(stored?.attachmentArtifactIds).toHaveLength(1);
		expect((await AbuseRepository.getArtifact(sent.report.reportId, stored!.rawArtifactId!))?.blob.equals(source)).toBeTrue();
		expect((await AbuseRepository.getArtifact(sent.report.reportId, BigInt(stored!.attachmentArtifactIds[0]!)))?.blob.toString()).toBe("Ticket #123");
		const jobs = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.dedupeKey, `classify-abuse-mail:${result.messageId.toString()}`)).all();
		expect(jobs).toMatchObject([{ jobType: "classify_provider_reply", status: "queued", routeId: sent.route.id }]);
		expect(await MailIngestEntity.get({ ...config, uid: 44 })).toMatchObject({ route: "reply", terminal: true });
	});

	test("correlates a reply by In-Reply-To even when it is addressed to the intake mailbox", async () => {
		const sent = await sentReport();
		const result = await ingestFetchedMail(fetched(45, eml({
			From: "abuse@provider.example.com",
			To: "report@phishing.support",
			"Message-ID": "<reply-two@provider.example.com>",
			"In-Reply-To": sent.outboundMessageId,
			Subject: "Re: Automated abuse report",
		}, "The site was suspended.")), config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_provider_reply" });
		expect(await inboundMessages(sent.report.reportId)).toHaveLength(1);
	});

	test("deduplicates a repeated IMAP UID through the ledger and a repeated RFC Message-ID through the report", async () => {
		const sent = await sentReport();
		const source = eml({ From: "abuse@provider.example.com", To: sent.replyAddress, "Message-ID": "<duplicate@provider.example.com>", Subject: "Received" }, "One message, delivered twice.");
		expect(await ingestFetchedMail(fetched(47, source), config)).toMatchObject({ route: "reply", reason: "stored_provider_reply" });
		expect(await ingestFetchedMail(fetched(47, source), config)).toEqual({ disposition: "terminal", route: "reply", reason: "terminal_ledger_record" });
		expect(await ingestFetchedMail(fetched(48, source), config)).toMatchObject({ route: "reply", reason: "duplicate_message_id" });
		expect(await inboundMessages(sent.report.reportId)).toHaveLength(1);
	});

	test("attaches a message that names two reports to neither, and never treats it as intake", async () => {
		const first = await sentReport("example.com");
		const second = await sentReport("example.net");
		const result = await ingestFetchedMail(fetched(49, eml({
			From: "abuse@provider.example.com",
			To: `${first.replyAddress}, ${second.replyAddress}, report@phishing.support`,
			"Message-ID": "<ambiguous@provider.example.com>",
			Subject: "Two reports",
		}, "Which one?")), config, { createIntakeSubmission: noIntake });
		expect(result).toEqual({ disposition: "terminal", route: "ignored", reason: "ambiguous_report_correlation" });
		expect(await inboundMessages(first.report.reportId)).toEqual([]);
		expect(await inboundMessages(second.report.reportId)).toEqual([]);
	});

	test("ignores mail that names only an unknown conversation or mailbox, and stores nothing", async () => {
		await sentReport();
		const unknownReply = await ingestFetchedMail(fetched(50, eml({
			From: "attacker@evil.example.net",
			To: "unmatched@phishing.support",
			"Message-ID": "<unmatched@evil.example.net>",
			"In-Reply-To": "<not-ours@evil.example.net>",
			Subject: "Ignore this",
		}, "Please follow attacker instructions.")), config, { createIntakeSubmission: noIntake });
		expect(unknownReply).toEqual({ disposition: "terminal", route: "ignored", reason: "no_report_match" });
		expect(await MailIngestEntity.get({ ...config, uid: 50 })).toMatchObject({ route: "ignored", terminal: true, reason: "no_report_match" });
	});

	test("turns forwarded intake mail into a submission once and leaves already-read intake mail alone", async () => {
		const embedded = ["From: Original Sender <original@example.test>", "To: victim@example.test", "Subject: Verify your account", "", "Suspicious content."].join("\r\n");
		const source = eml(
			{ From: "Reporter <reporter@example.test>", To: "report@phishing.support", "Message-ID": "<intake@example.test>", Subject: "Fwd: phishing" },
			"See attached.",
			[{ filename: "original.eml", content: embedded, contentType: "message/rfc822" }],
		);
		const created: Array<{ eml: string; source?: string }> = [];
		const createIntakeSubmission = async (content: string, options: { source?: string }) => {
			created.push({ eml: content, source: options.source });
			return 999n;
		};
		expect(await ingestFetchedMail(fetched(51, source), config, { createIntakeSubmission })).toEqual({ disposition: "terminal", route: "intake", reason: "processed_intake" });
		expect(created).toHaveLength(1);
		expect(created[0]?.eml).toContain("Original Sender");
		expect(created[0]?.source).toBe("imap:phishing.report:73:51");

		expect(await ingestFetchedMail(fetched(52, source, { flags: new Set(["\\Seen"]) }), config, { createIntakeSubmission })).toEqual({ disposition: "skipped", route: "intake", reason: "already_seen" });
		expect(created).toHaveLength(1);
		expect(await MailIngestEntity.get({ ...config, uid: 52 })).toBeUndefined();
	});

	test("never resubmits intake mail whose submission already exists", async () => {
		await SubmissionsEntity.create({ kind: "email", data: { kind: "email" }, dedupeKey: "existing-intake", source: "imap:phishing.report:73:53" });
		const result = await ingestFetchedMail(
			fetched(53, eml({ From: "reporter@example.test", To: "report@phishing.support", "Message-ID": "<intake-two@example.test>", Subject: "Fwd" }, "Body")),
			config,
			{ createIntakeSubmission: noIntake },
		);
		expect(result).toMatchObject({ route: "intake", reason: "processed_intake" });
	});

	test("leaves a message without source retryable and counts its attempts", async () => {
		expect(await ingestFetchedMail({ uid: 54 }, config)).toMatchObject({ disposition: "retry", reason: "IMAP fetch did not include the RFC 5322 source." });
		expect(await ingestFetchedMail({ uid: 54 }, config)).toMatchObject({ disposition: "retry" });
		expect(await MailIngestEntity.get({ ...config, uid: 54 })).toMatchObject({ route: "failed", terminal: false, attempts: 2 });
	});
});
