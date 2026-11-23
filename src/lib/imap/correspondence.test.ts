import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { simpleParser } from "mailparser";

import { getDb } from "../db";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { sendAbuseEmailRoute } from "../abuse/mail/send";
import { abuseCaseTag, authenticatedSender, canonicalSubject, subjectRepeats } from "../abuse/mail/correlation";
import { deliveryFailure } from "../abuse/mail/delivery_report";
import { AbuseRepository } from "../abuse/repository";
import { abuseJobs, abuseMailMessages } from "../abuse/schema";
import { classifyReply, nextContactRoute, routeToNextContact } from "../abuse/worker/mail";
import { repairIpRoutesWithoutFallback } from "../abuse/worker/ip_fallback_repair";
import { createAbuseEmailDraft } from "../abuse/mail/draft";
import type { ResolverDependencies } from "../abuse/resolver";
import { testRdapLocator } from "../network/rdap_test_helpers";
import { ensureRelayRefusalResends, readSendEmailPayload } from "../abuse/worker/email";
import { repairMisreadBounces } from "../abuse/worker/misread_bounces";
import { persistInboundAbuseMail } from "../abuse/mail/inbound";
import { deliveryReportFixture } from "../abuse/mail/fixtures/delivery_reports/fixture";
import { ingestFetchedMail, type MailIngestConfig } from "./ingest";
import { ingestMaildir, maildirUid } from "./maildir";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inboundMail, noIntake } from "./test_helpers";

useTemporaryDatabase();

const config: MailIngestConfig = { mailbox: "phishing.support", uidValidity: 1700000000, intakeAddress: "report@phishing.support" };
const environmentNames = ["SMTP_FROM", "REPLY_DOMAIN", "SMTP_HOST", "SMTP_RETURN_PATH"] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.SMTP_FROM = "support@phishing.support";
	process.env.REPLY_DOMAIN = "phishing.support";
	process.env.SMTP_HOST = "smtp.mail.me.com";
	delete process.env.SMTP_RETURN_PATH;
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

/** The header block iCloud prepends on delivery, with its own verdicts for `domain`. */
function icloudReceived(domain: string, verdict: "pass" | "fail" = "pass"): string[] {
	return [
		"Return-path: <bounce@example.invalid>",
		"Received: from mx.icloud.com by p00-icloudmta-asmtp; Mon, 26 Oct 2026 12:43:26 +0000",
		`Authentication-Results: dmarc.icloud.com; dmarc=${verdict} header.from=${domain}`,
		`Authentication-Results: dkim-verifier.icloud.com; dkim=${verdict} header.d=${domain} header.i=@${domain}`,
		`Received-SPF: ${verdict} (spf.icloud.com: domain of abuse@${domain})`,
		`Authentication-Results: spf.icloud.com; spf=${verdict} smtp.mailfrom=abuse@${domain}`,
		"Received: from sender.example (sender.example [192.0.2.1]) by mx.icloud.com",
	];
}

function eml(lines: string[], body: string): Buffer {
	return Buffer.from([...lines, "", body].join("\r\n"));
}

/** A sent abuse email to `recipient` for its own report, like production's Gransy report. */
async function sentReport(target: string, recipient: string, subject?: string, submissionId?: bigint, resolverProvenance: Record<string, unknown> = { source: "test" }) {
	const request = await validateAbuseReportRequest({
		targets: [target],
		allegationCategory: "phishing",
		description: "A credential-harvesting page impersonates a wallet provider.",
		observedUrls: [{ target, urls: [`https://${target}/start.php`] }],
	});
	if (submissionId !== undefined) {
		await SubmissionsEntity.create({ id: submissionId, kind: "website", data: { kind: "website", website: { url: `https://${target}/` } }, dedupeKey: `website-${target}`, status: "reported" });
	}
	const report = await AbuseRepository.createReport({ request, reporter: {}, ...(submissionId === undefined ? {} : { submissionId }) });
	const [reportTarget] = await AbuseRepository.listTargets(report.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(reportTarget!.id, {
		routeKey: `email:${recipient}`,
		providerRegistryKey: `email:${recipient.split("@")[1]}`,
		providerDisplayName: "Registrar abuse desk",
		routeType: "email",
		verifiedEmail: recipient,
		resolverProvenance,
		resolutionSnapshot: { source: "test" },
		status: "verified",
	});
	const delivery = await AbuseRepository.beginEmailDelivery({ routeId: route.id, providerPayload: { source: "test" }, correlationKey: `test-mail:${route.id.toString()}` });
	if (!delivery) throw new Error("Test email run was not created.");
	await sendAbuseEmailRoute({
		reportId: report.reportId,
		routeId: route.id,
		runId: delivery.run.id,
		recipient,
		subject: subject ?? `[Phishing Support] [${abuseCaseTag(report.reportId)}] Abuse report for ${target}`,
		body: `Case details: https://phishing.support/submissions/${(submissionId ?? report.reportId).toString()}`,
		correlationKey: delivery.run.correlationKey,
		transport: { sendMail: async (message) => { submissions.push({ envelopeFrom: message.envelope.from, from: message.raw.toString("utf8").match(/^From: (.+)$/m)?.[1]?.trim(), dsn: message.dsn }); return { messageId: "smtp-test" }; } },
	});
	await AbuseRepository.settleEmailDelivery({ runId: delivery.run.id, expectedRunStatus: "starting", expectedRouteStatus: "running", outcome: "sent" });
	const outbound = await AbuseRepository.getOutboundMailForRun(delivery.run.id);
	if (!outbound?.messageId) throw new Error("Test outbound message was not persisted.");
	return { reportId: report.reportId, route, outbound, tag: abuseCaseTag(report.reportId) };
}

/** What each report sent by `sentReport` handed the relay: envelope sender, From header, notice request. */
const submissions: Array<{ envelopeFrom: string; from?: string; dsn: unknown }> = [];

describe("helpdesk replies without threading headers", () => {
	test("Gransy's reply to support@ with a ticket-prefixed subject attaches to the case it names", async () => {
		const sent = await sentReport("migrationqueuetrustdex.com", "abuse@regtons.com");
		const other = await sentReport("other-phish.com", "abuse@regtons.com");
		const result = await ingestFetchedMail({
			uid: 578,
			source: eml([
				...icloudReceived("regtons.com"),
				"To: support@phishing.support",
				`Subject: [Abuse@15727218] ${sent.outbound.subject}`,
				"From: Abuse <abuse@regtons.com>",
				"Message-Id: <1a244b3cc23edb85b9c68c987b8a87a2.abuseregtonscom@subreg.cz>",
			], "> Hello,\r\n> \r\n> Domain(s) suspended.\r\n> Abuse team Gransy s. r. o."),
		}, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ disposition: "terminal", route: "reply", reason: "stored_provider_reply" });
		expect(await inboundMail(sent.reportId)).toMatchObject([{ kind: "reply", fromAddress: "abuse@regtons.com" }]);
		expect(await inboundMail(other.reportId)).toEqual([]);
	});

	test("Contabo's ticket reply from contabo.com attaches to the report we mailed to contabo.de; another company's TLD twin does not", async () => {
		// 2026-11-19: Contabo answered abuse@contabo.de reports from no-reply@contabo.com without threading headers.
		const sent = await sentReport("usc1.contabostorage.com", "abuse@contabo.de");
		const other = await sentReport("other.contabostorage.com", "abuse@contabo.de");
		const reply = (uid: number, domain: string) => ingestFetchedMail({
			uid,
			source: eml([
				...icloudReceived(domain),
				"To: support@phishing.support",
				`Subject: [Ticket#2026111910007915] Re: ${sent.outbound.subject}`,
				`From: Contabo <no-reply@${domain}>`,
				`Message-Id: <1795109408.49436.${uid}@ticketsystem.${domain}>`,
			], "Dear Sir or Madam, we could not find a domain or an IP address which we can assign to Contabo products."),
		}, config, { createIntakeSubmission: noIntake });
		expect(await reply(610, "contabo.com")).toMatchObject({ route: "reply", reason: "stored_provider_reply" });
		expect(await inboundMail(sent.reportId)).toMatchObject([{ kind: "reply", fromAddress: "no-reply@contabo.com" }]);
		expect(await inboundMail(other.reportId)).toEqual([]);
		// The same name is not enough on its own: a sender we never mailed under any TLD stays unmatched.
		expect(await reply(611, "contabo-support.com")).toMatchObject({ route: "ignored", reason: "no_report_match" });
	});

	test("a reply that only quotes our case URL attaches to that case", async () => {
		const sent = await sentReport("quote-only.com", "abuse@regtons.com", "Abuse report", 373042876772257865n);
		await sentReport("unrelated.com", "abuse@regtons.com");
		const result = await ingestFetchedMail({
			uid: 600,
			source: eml([
				...icloudReceived("regtons.com"),
				"To: support@phishing.support",
				"Subject: Your ticket was closed",
				"From: abuse@regtons.com",
				"Message-Id: <ticket-closed@subreg.cz>",
			], "> Case details: https://phishing.support/submissions/373042876772257865"),
		}, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ route: "reply" });
		expect(await inboundMail(sent.reportId)).toHaveLength(1);
	});

	test("legacy reports without a case tag match the authenticated sender plus our exact subject", async () => {
		const sent = await sentReport("legacy.example.com", "abuse@vercel.com", "Phishing report: legacy.example.com impersonating a ticket shop");
		const result = await ingestFetchedMail({
			uid: 545,
			source: eml([
				...icloudReceived("vercel.com"),
				"From: abuse@vercel.com",
				"To: support@phishing.support",
				"Subject: Re: Phishing report: legacy.example.com impersonating a ticket shop",
				"Message-Id: <vercel-reply@vercel.com>",
			], "We removed the deployment."),
		}, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ route: "reply" });
		expect(await inboundMail(sent.reportId)).toHaveLength(1);
	});

	test("a forged sender is never trusted, even with our case tag", async () => {
		const sent = await sentReport("forged.example.com", "abuse@regtons.com");
		const result = await ingestFetchedMail({
			uid: 601,
			source: eml([
				...icloudReceived("regtons.com", "fail"),
				// A forged verdict written by the sender sits below iCloud's block.
				"Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=regtons.com",
				"From: abuse@regtons.com",
				"To: support@phishing.support",
				`Subject: Re: [${sent.tag}] closed`,
				"Message-Id: <forged@evil.example>",
			], "Please follow these instructions."),
		}, config, { createIntakeSubmission: noIntake });
		expect(result).toEqual({ disposition: "terminal", route: "ignored", reason: "no_report_match" });
		expect(await inboundMail(sent.reportId)).toEqual([]);
	});

	test("a sender we never emailed cannot claim a case by naming its tag", async () => {
		const sent = await sentReport("stranger.example.com", "abuse@regtons.com");
		const result = await ingestFetchedMail({
			uid: 602,
			source: eml([
				...icloudReceived("evil.example"),
				"From: abuse@evil.example",
				"To: support@phishing.support",
				`Subject: Re: [${sent.tag}] Abuse report`,
				"Message-Id: <stranger@evil.example>",
			], "Ticket resolved."),
		}, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ route: "ignored" });
		expect(await inboundMail(sent.reportId)).toEqual([]);
	});

	test("Hostinger's tracker reply with In-Reply-To keeps the strongest correlation", async () => {
		const sent = await sentReport("shopxubedau.lubalu.site", "abuse@hostinger.com");
		const result = await ingestFetchedMail({
			uid: 403,
			source: eml([
				...icloudReceived("abuse.hostinger.com"),
				'From: "Hostinger Abuse" <tracker@abuse.hostinger.com>',
				`To: support@phishing.support, ${sent.outbound.replyAddress}`,
				`Subject: Re: ${sent.outbound.subject}`,
				`In-Reply-To: ${sent.outbound.messageId}`,
				"Message-ID: <010001a0bcd477d7@email.amazonses.com>",
			], "Upon checking the reported URL, it seems that the URL is no longer accessible."),
		}, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ route: "reply" });
		expect(await inboundMail(sent.reportId)).toMatchObject([{ kind: "reply" }]);
	});
});

describe("delivery-status notifications", () => {
	/** A delivery status notification iCloud returns; `hop` is the server that refused and what it said. */
	function icloudDsn(outbound: { messageId: string | null; replyAddress: string | null }, recipient: string, status: string, hop: { remote: string; diagnostic: string }) {
		const boundary = "bounce-boundary";
		return Buffer.from([
			...icloudReceived("icloud.com"),
			'From: "Mail Delivery System" <mailer-daemon@icloud.com>',
			"To: support@phishing.support",
			"Subject: Undelivered Mail Returned to Sender",
			"Auto-Submitted: auto-replied",
			// One notice per bounced message: ingestion drops a repeated Message-Id.
			`Message-Id: <20261020141158.${(outbound.messageId ?? "").replace(/[<>@.]/g, "")}@outbound.qs.icloud.com>`,
			"MIME-Version: 1.0",
			`Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
			"",
			`--${boundary}`,
			"Content-Type: text/plain",
			"",
			`<${recipient}>: host ${hop.remote} said: ${hop.diagnostic}`,
			`--${boundary}`,
			"Content-Type: message/delivery-status",
			"",
			"Reporting-MTA: dns; outbound.qs.icloud.com",
			"",
			`Original-Recipient: rfc822;${recipient}`,
			"Action: failed",
			`Status: ${status.replace(/^(\d)(\d\d)$/, "$1.7.1")}`,
			`Remote-MTA: dns; ${hop.remote}`,
			`Diagnostic-Code: smtp; ${hop.diagnostic}`,
			`--${boundary}`,
			"Content-Type: text/rfc822-headers",
			"",
			"From: support@phishing.support",
			`To: ${recipient}`,
			`Reply-To: ${outbound.replyAddress}`,
			`Message-ID: ${outbound.messageId}`,
			`--${boundary}--`,
			"",
		].join("\r\n"));
	}

	/** The recipient's own server refused the report. */
	function icloudBounce(outbound: { messageId: string | null; replyAddress: string | null }, recipient: string, status: string) {
		return icloudDsn(outbound, recipient, status, { remote: `mx.${recipient.split("@")[1]}`, diagnostic: `${status} ${status[0]}.1.1 <${recipient}>: Recipient address rejected` });
	}

	/** iCloud's outbound filter refused the report before it left (production, 2026-11-19). */
	function icloudRelayRefusal(outbound: { messageId: string | null; replyAddress: string | null }, recipient: string) {
		return icloudDsn(outbound, recipient, "550", { remote: "127.0.0.1", diagnostic: "550 5.7.1 [CS101] Message rejected due to local policy; if you feel that your email was rejected in error, please forward a copy to icloudadmin@apple.com. Txn ID 62c2a436-70f7-4c0e-b64b-2469afc3b0fa" });
	}

	test("every report asks the relay for failure notices with its headers only, sent to the return path", async () => {
		submissions.length = 0;
		await sentReport("dsn-request.example.com", "abuse@dsn-request.example");
		process.env.SMTP_RETURN_PATH = "Bounces@Mail.Phishing.Support";
		await sentReport("return-path.example.com", "abuse@dsn-request.example");
		expect(submissions).toEqual([
			{ envelopeFrom: "support@phishing.support", from: "support@phishing.support", dsn: { ret: "HDRS", notify: "FAILURE" } },
			{ envelopeFrom: "bounces@mail.phishing.support", from: "support@phishing.support", dsn: { ret: "HDRS", notify: "FAILURE" } },
		]);
	});

	test("parses which of our messages bounced", async () => {
		const parsed = await simpleParser(icloudBounce({ messageId: "<abuse-d984c10d2a49288f@phishing.support>", replyAddress: "abuse-ef16@phishing.support" }, "iarpoc@newfold.com", "550"));
		expect(deliveryFailure(parsed)).toEqual({ messageIds: ["<abuse-d984c10d2a49288f@phishing.support>"] });
	});

	test("a permanent rejection marks the route undeliverable without resending", async () => {
		const sent = await sentReport("oxwitik.com", "iarpoc@newfold.com");
		const result = await ingestFetchedMail({ uid: 538, source: icloudBounce(sent.outbound, "iarpoc@newfold.com", "550") }, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ route: "reply" });
		const [bounce] = await inboundMail(sent.reportId);
		expect(bounce).toMatchObject({ kind: "bounce", references: [sent.outbound.messageId] });
		await classifyReply(bounce!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect(await AbuseRepository.getMailMessage(bounce!.id)).toMatchObject({ classification: "bounce" });
		const resends = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, sent.route.id)).all().filter((job) => job.jobType === "send_email");
		expect(resends).toEqual([]);
	});

	test("a permanent rejection moves the report to the target's next published abuse contact", async () => {
		// keychainagent.pro: the registry's abuse@eranet.com does not exist; Eranet's own RDAP names support@tnet.hk.
		const sent = await sentReport("keychain.example.com", "abuse@deadbox.example", undefined, undefined, {
			email: "abuse@deadbox.example",
			source: "domain_rdap",
			fallbackContacts: [{ email: "support@helpdesk.example", source: "registrar_rdap", entityName: "Helpdesk" }, { email: "cs@helpdesk.example", source: "domain_whois" }],
		});
		await ingestFetchedMail({ uid: 540, source: icloudBounce(sent.outbound, "abuse@deadbox.example", "553") }, config, { createIntakeSubmission: noIntake });
		const [bounce] = await inboundMail(sent.reportId);
		await classifyReply(bounce!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });

		const routes = await AbuseRepository.listRoutes(sent.reportId);
		const next = routes.find((route) => route.verifiedEmail === "support@helpdesk.example");
		expect(next).toMatchObject({ routeType: "email", status: "verified", providerDisplayName: "Helpdesk" });
		expect(next?.resolverProvenance).toMatchObject({
			reason: "fallback_after_permanent_bounce",
			bouncedRouteId: sent.route.id.toString(),
			fallbackContacts: [{ email: "cs@helpdesk.example", source: "domain_whois" }],
		});
		const jobs = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, next!.id)).all();
		expect(jobs.map((job) => job.jobType)).toEqual(["send_email"]);
		// No resend to the dead mailbox itself.
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, sent.route.id)).all().filter((job) => job.jobType === "send_email")).toEqual([]);
		// A replayed classification never opens a second route for the same contact.
		await (await import("../abuse/worker/mail")).routeToNextContact(sent.route.id);
		expect((await AbuseRepository.listRoutes(sent.reportId)).filter((route) => route.verifiedEmail === "support@helpdesk.example")).toHaveLength(1);
	});

	test("a temporary failure retries the same mailbox and never falls back", async () => {
		const sent = await sentReport("greylisted-fallback.example.com", "abuse@greylist2.example", undefined, undefined, {
			email: "abuse@greylist2.example",
			source: "domain_rdap",
			fallbackContacts: [{ email: "support@other.example", source: "registrar_rdap" }],
		});
		await ingestFetchedMail({ uid: 541, source: icloudBounce(sent.outbound, "abuse@greylist2.example", "451") }, config, { createIntakeSubmission: noIntake });
		const [bounce] = await inboundMail(sent.reportId);
		await classifyReply(bounce!.id);
		expect((await AbuseRepository.listRoutes(sent.reportId)).map((route) => route.verifiedEmail)).toEqual(["abuse@greylist2.example"]);
	});

	type Outbound = { messageId: string | null; replyAddress: string | null };

	/** A report to `recipient` (with a fallback contact) whose first attempt `refusal` answered. */
	async function refusedReport(domain: string, recipient: string, refusal: (outbound: Outbound) => Buffer) {
		const sent = await sentReport(domain, recipient, undefined, undefined, {
			email: recipient,
			source: "domain_rdap",
			fallbackContacts: [{ email: "support@other-desk.example", source: "registrar_rdap" }],
		});
		await ingestFetchedMail({ uid: nextUid++, source: refusal(sent.outbound) }, config, { createIntakeSubmission: noIntake });
		const [first] = await inboundMail(sent.reportId);
		await classifyReply(first!.id);
		const sends = () => sendJobs(sent.route.id);
		/** The queued resend goes out and `answer` comes back for it. */
		const resendAnswered = async (answer: (outbound: Outbound) => Buffer) => {
			await ingestFetchedMail({ uid: nextUid++, source: answer(await resendReport(sent)) }, config, { createIntakeSubmission: noIntake });
			await classifyReply((await inboundMail(sent.reportId)).filter((message) => message.kind === "bounce").at(-1)!.id);
		};
		return { ...sent, refusal: first!, sends, resendAnswered };
	}

	const sendJobs = (routeId: bigint) => getDb().then((db) => db.select().from(abuseJobs).where(eq(abuseJobs.routeId, routeId)).all().filter((job) => job.jobType === "send_email"));
	let resends = 0;
	/** The route's queued resend goes out (its job done): the new send's outbound mail. */
	async function resendReport(sent: Awaited<ReturnType<typeof sentReport>>) {
		const db = await getDb();
		db.update(abuseJobs).set({ status: "completed" }).where(eq(abuseJobs.routeId, sent.route.id)).run();
		const retry = await AbuseRepository.beginEmailDelivery({ routeId: sent.route.id, providerPayload: { source: "test" }, correlationKey: `test-mail:${sent.route.id.toString()}:resend-${++resends}` });
		await sendAbuseEmailRoute({
			reportId: sent.reportId, routeId: sent.route.id, runId: retry!.run.id, recipient: sent.route.verifiedEmail!,
			subject: "resend", body: "resend", correlationKey: retry!.run.correlationKey,
			transport: { sendMail: async () => ({ messageId: `smtp-test-resend-${resends}` }) },
		});
		await AbuseRepository.settleEmailDelivery({ runId: retry!.run.id, expectedRunStatus: "starting", expectedRouteStatus: "running", outcome: "sent" });
		return (await AbuseRepository.listMailForReport(sent.reportId)).filter((message) => message.direction === "outbound" && message.status === "sent").at(-1)!;
	}
	const relayRefusedReport = (domain: string, recipient: string) => refusedReport(domain, recipient, (outbound) => icloudRelayRefusal(outbound, recipient));
	let nextUid = 590;

	test("a server refusing the attached phishing mail gets the report once more with it as text; a second refusal is the mailbox's", async () => {
		const recipient = "abuse@attachment-desk.example";
		const attachmentRefusal = (outbound: Outbound) => icloudDsn(outbound, recipient, "550", { remote: "mx.attachment-desk.example", diagnostic: "550 Attached file 'phishing-email.eml' has disallowed extension" });
		const sent = await refusedReport("attachment-refused.example.com", recipient, attachmentRefusal);
		expect(await AbuseRepository.getMailMessage(sent.refusal.id)).toMatchObject({ classification: "bounce", disposition: "attachment_refusal" });
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect((await AbuseRepository.listRoutes(sent.reportId)).map((route) => route.verifiedEmail)).toEqual([recipient]);
		const [resend] = await sent.sends();
		expect(resend).toMatchObject({ status: "queued", payload: { retryReason: "attachment_refused" } });
		expect(readSendEmailPayload(resend!.payload)).toEqual({ attachedMessagesAsText: true });

		await sent.resendAnswered(attachmentRefusal);
		expect((await inboundMail(sent.reportId)).map((message) => message.disposition)).toEqual(["attachment_refusal", "delivery_status_notification"]);
		expect((await sent.sends()).map((job) => job.id)).toEqual([resend!.id]);
		expect((await AbuseRepository.listRoutes(sent.reportId)).map((route) => route.verifiedEmail)).toEqual([recipient, "support@other-desk.example"]);
	});

	test("a bounce our relay files into its Maildir settles the report; every message leaves new/ once handled, and a rerun changes nothing", async () => {
		const recipient = "abuse@maildir-desk.example";
		const sent = await sentReport("maildir-bounce.example.com", recipient);
		const dir = await mkdtemp(path.join(tmpdir(), "relay-bounces-"));
		await mkdir(path.join(dir, "new"));
		await writeFile(path.join(dir, "new", "1795112712.V801I2M3.mail.phishing.support"), icloudBounce(sent.outbound, recipient, "550"));
		await writeFile(path.join(dir, "new", "1795112713.V801I4M5.mail.phishing.support"), eml(["From: someone@spam.example", "To: bounces@mail.phishing.support", "Subject: hello", "Message-Id: <unrelated@spam.example>"], "Nothing to do with any report."));
		await ingestMaildir(dir, config.intakeAddress);
		const [bounce] = await inboundMail(sent.reportId);
		expect(bounce).toMatchObject({ kind: "bounce" });
		await classifyReply(bounce!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect(await readdir(path.join(dir, "new"))).toEqual([]);
		expect((await readdir(path.join(dir, "cur"))).sort()).toEqual(["1795112712.V801I2M3.mail.phishing.support:2,S", "1795112713.V801I4M5.mail.phishing.support:2,S"]);
		await ingestMaildir(dir, config.intakeAddress);
		expect(await inboundMail(sent.reportId)).toHaveLength(1);
	});

	test("a missing Maildir is no error, and a file's stand-in UID is a stable safe integer", async () => {
		await ingestMaildir(path.join(tmpdir(), "no-such-relay-maildir"), config.intakeAddress);
		const uid = maildirUid("1795112712.V801I2M3.mail.phishing.support");
		expect(Number.isSafeInteger(uid) && uid > 0).toBe(true);
		expect(maildirUid("1795112712.V801I2M3.mail.phishing.support")).toBe(uid);
		expect(maildirUid("1795112712.V801I2M4.mail.phishing.support")).not.toBe(uid);
	});

	test("a refusal by our own relay never moves to another contact; the relay gets one resend, freshly drafted, and a second refusal ends it", async () => {
		const sent = await relayRefusedReport("relay-refused.example.com", "abuse@relay-refused.example");
		expect(await AbuseRepository.getMailMessage(sent.refusal.id)).toMatchObject({ kind: "bounce", classification: "relay_refused", disposition: "relay_refusal" });
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		// The provider's mailbox is not dead: no other contact is tried.
		expect((await AbuseRepository.listRoutes(sent.reportId)).map((route) => route.verifiedEmail)).toEqual(["abuse@relay-refused.example"]);
		const [resend] = await sent.sends();
		expect(resend).toMatchObject({ status: "queued", payload: { retryReason: "relay_refused", relay: "smtp.mail.me.com" } });
		expect(readSendEmailPayload(resend!.payload)).toEqual({ redraft: true });

		await sent.resendAnswered((outbound) => icloudRelayRefusal(outbound, "abuse@relay-refused.example"));
		expect((await inboundMail(sent.reportId)).map((message) => message.classification)).toEqual(["relay_refused", "relay_refused"]);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect((await sent.sends()).map((job) => job.id)).toEqual([resend!.id]);
		// A restart through the same relay queues nothing either.
		await ensureRelayRefusalResends();
		expect((await sent.sends()).map((job) => job.id)).toEqual([resend!.id]);
	});

	test("once the relay changes, every report the old relay refused last goes out once through the new one", async () => {
		const sent = await relayRefusedReport("relay-moved.example.com", "abuse@relay-moved.example");
		await sent.resendAnswered((outbound) => icloudRelayRefusal(outbound, "abuse@relay-moved.example"));
		process.env.SMTP_HOST = "phishing-mailer";
		await ensureRelayRefusalResends();
		await ensureRelayRefusalResends();
		const sends = await sent.sends();
		expect(sends.map((job) => job.payload)).toEqual([{ retryReason: "relay_refused", relay: "smtp.mail.me.com" }, { retryReason: "relay_refused", relay: "phishing-mailer" }]);
		expect(sends.at(-1)).toMatchObject({ status: "queued", dedupeKey: `relay-resend:${sent.route.id.toString()}:phishing-mailer` });
	});

	test("a report the provider bounced after a relay refusal is not resent when the relay changes", async () => {
		const sent = await relayRefusedReport("relay-then-bounce.example.com", "abuse@relay-then-bounce.example");
		await sent.resendAnswered((outbound) => icloudBounce(outbound, "abuse@relay-then-bounce.example", "550"));
		expect((await inboundMail(sent.reportId)).map((message) => message.classification)).toEqual(["relay_refused", "bounce"]);
		process.env.SMTP_HOST = "phishing-mailer";
		await ensureRelayRefusalResends();
		expect((await sent.sends()).map((job) => job.payload?.relay)).toEqual(["smtp.mail.me.com"]);
	});

	test("a temporary failure queues one resend with the same identity", async () => {
		const sent = await sentReport("greylisted.example.com", "abuse@greylist.example");
		await ingestFetchedMail({ uid: 539, source: icloudBounce(sent.outbound, "abuse@greylist.example", "451") }, config, { createIntakeSubmission: noIntake });
		const [bounce] = await inboundMail(sent.reportId);
		await classifyReply(bounce!.id);
		expect(await sendJobs(sent.route.id)).toHaveLength(1);
	});

	const NEXT_CONTACT = "support@next-desk.example";
	/** A report to `recipient` whose target publishes one more abuse contact. */
	const reportWithNextContact = (domain: string, recipient: string) =>
		sentReport(domain, recipient, undefined, undefined, { email: recipient, source: "domain_rdap", fallbackContacts: [{ email: NEXT_CONTACT, source: "registrar_rdap" }] });
	const contactsOf = async (reportId: bigint) => (await AbuseRepository.listRoutes(reportId)).map((route) => route.verifiedEmail);
	const queuedSends = async (routeId: bigint) => (await sendJobs(routeId)).filter((job) => job.status === "queued");

	test("Office 365's non-delivery report, threaded to our report like a reply, is a bounce: the dead mailbox fails once and the report moves on", async () => {
		const recipient = "ip.abuse@isp-one.example";
		const sent = await reportWithNextContact("o365-forwarded.example.com", recipient);
		const result = await ingestFetchedMail({ uid: nextUid++, source: deliveryReportFixture("office365-forwarded-recipients-not-found.eml", sent.outbound) }, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ route: "reply" });
		const [bounce] = await inboundMail(sent.reportId);
		expect(bounce).toMatchObject({ kind: "bounce", inReplyTo: sent.outbound.messageId });
		expect(bounce!.references).toContain(sent.outbound.messageId!);

		await classifyReply(bounce!.id);
		expect(await AbuseRepository.getMailMessage(bounce!.id)).toMatchObject({ classification: "bounce", disposition: "delivery_status_notification" });
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect((await AbuseRepository.getMailMessage(sent.outbound.id))?.error).toStartWith("smtp;550 5.4.1 Recipient address rejected: Access denied.");
		// No resend to the dead mailbox: the report goes to the next contact instead.
		expect(await sendJobs(sent.route.id)).toEqual([]);
		expect(await contactsOf(sent.reportId)).toEqual([recipient, NEXT_CONTACT]);

		// Its classification replayed after a worker restart changes nothing.
		await classifyReply(bounce!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect(await contactsOf(sent.reportId)).toEqual([recipient, NEXT_CONTACT]);
		expect(await sendJobs(sent.route.id)).toEqual([]);
	});

	test.each(["exim-permanent.eml", "gmail-failed-permanently.eml", "qmail-permanent.eml", "icloud-postfix-rejected.eml"])("%s: a permanent failure moves the report on to the next contact", async (name) => {
		const slug = name.replace(/\W/g, "-");
		const sent = await reportWithNextContact(`${slug}.example.com`, `abuse@${slug}.example`);
		await ingestFetchedMail({ uid: nextUid++, source: deliveryReportFixture(name, sent.outbound) }, config, { createIntakeSubmission: noIntake });
		const [bounce] = await inboundMail(sent.reportId);
		expect(bounce).toMatchObject({ kind: "bounce" });
		await classifyReply(bounce!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect(await sendJobs(sent.route.id)).toEqual([]);
		expect(await contactsOf(sent.reportId)).toEqual([`abuse@${slug}.example`, NEXT_CONTACT]);
	});

	test.each(["gmail-delay-warning.eml", "postfix-temporary.eml"])("%s: a temporary failure resends to the same mailbox once", async (name) => {
		const slug = name.replace(/\W/g, "-");
		const sent = await reportWithNextContact(`${slug}.example.com`, `abuse@${slug}.example`);
		await ingestFetchedMail({ uid: nextUid++, source: deliveryReportFixture(name, sent.outbound) }, config, { createIntakeSubmission: noIntake });
		const [bounce] = await inboundMail(sent.reportId);
		expect(bounce).toMatchObject({ kind: "bounce" });
		await classifyReply(bounce!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect(await queuedSends(sent.route.id)).toHaveLength(1);
		expect(await contactsOf(sent.reportId)).toEqual([`abuse@${slug}.example`]);
	});

	test("a notice about a send that already failed changes nothing once the report went out again; the resend's own failure still counts", async () => {
		const recipient = "abuse@greylist-then-dead.example";
		const sent = await reportWithNextContact("greylist-then-dead.example.com", recipient);
		await ingestFetchedMail({ uid: nextUid++, source: icloudBounce(sent.outbound, recipient, "451") }, config, { createIntakeSubmission: noIntake });
		const [greylisted] = await inboundMail(sent.reportId);
		await classifyReply(greylisted!.id);
		const resent = await resendReport(sent);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "awaiting_provider_reply" });

		// Production, 2026-11-20: a deploy restarted the worker mid-job, and the replayed
		// classification of the first notice ended the route that was waiting on the resend.
		await classifyReply(greylisted!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "awaiting_provider_reply" });
		expect(await AbuseRepository.getMailMessage(resent.id)).toMatchObject({ status: "sent" });
		expect(await queuedSends(sent.route.id)).toEqual([]);

		await ingestFetchedMail({ uid: nextUid++, source: deliveryReportFixture("office365-forwarded-recipients-not-found.eml", resent) }, config, { createIntakeSubmission: noIntake });
		await classifyReply((await inboundMail(sent.reportId)).find((message) => message.inReplyTo === resent.messageId)!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect(await contactsOf(sent.reportId)).toEqual([recipient, NEXT_CONTACT]);
	});

	test("a no-reply autoresponder threaded to our report stays a reply", async () => {
		const sent = await sentReport("autoresponder.example.com", "network-abuse@cloud.example");
		await ingestFetchedMail({ uid: nextUid++, source: deliveryReportFixture("google-noreply-autoresponder.eml", sent.outbound) }, config, { createIntakeSubmission: noIntake });
		expect(await inboundMail(sent.reportId)).toMatchObject([{ kind: "reply", fromAddress: "network-abuse+noreply@google.com" }]);
	});

	describe("a mailbox that keeps failing temporarily", () => {
		const lastBounce = async (reportId: bigint) => (await inboundMail(reportId)).filter((message) => message.kind === "bounce").at(-1)!;
		const lastStatusChange = async (reportId: bigint, routeId: bigint) => (await AbuseRepository.listEvents(reportId)).filter((event) => event.routeId === routeId && event.eventType === "route.status_changed").at(-1)?.data;

		test("is resent with doubling waits until its sixth send fails, then the report moves on", async () => {
			const recipient = "abuse@always-greylisted.example";
			const sent = await reportWithNextContact("always-greylisted.example.com", recipient);
			let outbound: Outbound = sent.outbound;
			const waits: number[] = [];
			for (let send = 1; send <= 6; send++) {
				await ingestFetchedMail({ uid: nextUid++, source: icloudBounce(outbound, recipient, "451") }, config, { createIntakeSubmission: noIntake });
				await classifyReply((await lastBounce(sent.reportId)).id);
				expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
				const queued = await queuedSends(sent.route.id);
				if (send === 6) {
					expect(queued).toEqual([]);
					break;
				}
				expect(queued).toHaveLength(1);
				waits.push(Math.round((queued[0]!.nextAttemptAt!.getTime() - queued[0]!.createdAt.getTime()) / 60_000));
				expect(await contactsOf(sent.reportId)).toEqual([recipient]);
				outbound = await resendReport(sent);
			}
			expect(waits).toEqual([15, 30, 60, 120, 240]);
			expect(await contactsOf(sent.reportId)).toEqual([recipient, NEXT_CONTACT]);
			expect(await lastStatusChange(sent.reportId, sent.route.id)).toMatchObject({ to: "delivery_failed", reason: "delivery_retries_exhausted" });
			expect((await AbuseRepository.getMailMessage((await lastBounce(sent.reportId)).id))).toMatchObject({ classification: "bounce", disposition: "delivery_status_notification" });
		});

		test("three days after its first send, a temporary failure counts as permanent", async () => {
			const recipient = "abuse@slow-queue.example";
			const sent = await reportWithNextContact("slow-queue.example.com", recipient);
			(await getDb()).update(abuseMailMessages).set({ createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000) }).where(eq(abuseMailMessages.id, sent.outbound.id)).run();
			await ingestFetchedMail({ uid: nextUid++, source: icloudBounce(sent.outbound, recipient, "451") }, config, { createIntakeSubmission: noIntake });
			await classifyReply((await lastBounce(sent.reportId)).id);
			expect(await queuedSends(sent.route.id)).toEqual([]);
			expect(await contactsOf(sent.reportId)).toEqual([recipient, NEXT_CONTACT]);
			expect((await AbuseRepository.getMailMessage(sent.outbound.id))?.error).toContain("treated as permanent");
		});

		test("without another contact the route simply ends failed", async () => {
			const recipient = "abuse@greylisted-alone.example";
			const sent = await sentReport("greylisted-alone.example.com", recipient);
			(await getDb()).update(abuseMailMessages).set({ createdAt: new Date(Date.now() - 4 * 24 * 60 * 60_000) }).where(eq(abuseMailMessages.id, sent.outbound.id)).run();
			await ingestFetchedMail({ uid: nextUid++, source: icloudBounce(sent.outbound, recipient, "451") }, config, { createIntakeSubmission: noIntake });
			await classifyReply((await lastBounce(sent.reportId)).id);
			expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
			expect(await queuedSends(sent.route.id)).toEqual([]);
			expect(await contactsOf(sent.reportId)).toEqual([recipient]);
		});
	});

	describe("a hosting address's contacts after its own mailbox is dead", () => {
		const IP = "14.194.139.244";
		const DEAD = "ip.abuse@tatatel.co.in";
		const UPSTREAM = "4755abuse@tatacommunications.com";
		const transit = { upstreamAsn: 4755, customerAsn: 45820, customerOrganization: "TTSL-ISP DIVISION", customerPrefix: "14.194.136.0/21" };
		const infrastructureProvenance = (domain: string, fallbackContacts?: unknown[]) => ({
			source: "domain_infrastructure_ip",
			originatingDomain: domain,
			originatingIp: IP,
			dnsResolution: { publicAddresses: [IP] },
			ipRouteProvenance: { email: DEAD, source: "ip_rdap", entityName: "IRT-TATA-DOCOMO-IN" },
			...(fallbackContacts ? { fallbackContacts } : {}),
		});
		const bounceDead = async (sent: Awaited<ReturnType<typeof sentReport>>) => {
			await ingestFetchedMail({ uid: nextUid++, source: deliveryReportFixture("office365-forwarded-recipients-not-found.eml", sent.outbound) }, config, { createIntakeSubmission: noIntake });
			await classifyReply((await inboundMail(sent.reportId)).find((message) => message.kind === "bounce")!.id);
		};

		test("the upstream gets the report as the route found through the same address, told whose network it is and which mailbox bounced", async () => {
			const sent = await sentReport("zealous-upstream.example.com", DEAD, undefined, undefined, infrastructureProvenance("zealous-upstream.example.com", [
				{ email: UPSTREAM, source: "upstream_asn_rdap", entityName: "IRT-TATACOMM-IN", organization: "Tata Communications Limited", transit },
			]));
			await bounceDead(sent);
			const next = (await AbuseRepository.listRoutes(sent.reportId)).find((route) => route.verifiedEmail === UPSTREAM)!;
			expect(next).toMatchObject({ status: "verified", providerDisplayName: "Tata Communications Limited" });
			expect(next.resolverProvenance).toEqual({
				source: "domain_infrastructure_ip",
				originatingDomain: "zealous-upstream.example.com",
				originatingIp: IP,
				dnsResolution: { publicAddresses: [IP] },
				ipRouteProvenance: {
					email: UPSTREAM, source: "upstream_asn_rdap", entityName: "IRT-TATACOMM-IN", organization: "Tata Communications Limited", transit,
					reason: "fallback_after_permanent_bounce", bouncedRouteId: sent.route.id.toString(), bouncedEmails: [DEAD],
				},
			});
			expect(await nextContactRoute(sent.route)).toMatchObject({ id: next.id });

			const report = (await AbuseRepository.getReport(sent.reportId))!;
			const [target] = await AbuseRepository.listTargets(sent.reportId);
			const draft = await createAbuseEmailDraft({ report, target: target!, route: next, recipient: UPSTREAM }, { generateSummary: async () => undefined });
			expect(draft.recipientLabel).toBe("Tata Communications Limited");
			expect(draft.body).toContain("Why you: the reported address is in 14.194.136.0/21, announced by AS45820 (TTSL-ISP DIVISION), your downstream customer, whose traffic you carry as its upstream transit provider.");
			expect(draft.body).toContain(`Its published abuse mailbox ${DEAD} rejects mail, so please pass this report to your customer or act on it.`);
			expect(draft.body).toContain(`Hosting IP address: ${IP}`);
			expect(draft.body).not.toContain("Public resolver data lists this address as the abuse contact");
		});

		test("a chain of dead mailboxes is walked one bounce at a time, each named to the next", async () => {
			const sent = await sentReport("zealous-chain.example.com", DEAD, undefined, undefined, infrastructureProvenance("zealous-chain.example.com", [
				{ email: "abuse@origin-asn.example", source: "asn_rdap" },
				{ email: UPSTREAM, source: "upstream_asn_rdap", transit },
			]));
			await bounceDead(sent);
			const origin = (await AbuseRepository.listRoutes(sent.reportId)).find((route) => route.verifiedEmail === "abuse@origin-asn.example")!;
			expect(origin.resolverProvenance).toMatchObject({ fallbackContacts: [{ email: UPSTREAM }], ipRouteProvenance: { bouncedEmails: [DEAD] } });
			await AbuseRepository.transitionRouteStatus({ routeId: origin.id, from: "verified", to: "delivery_failed" });
			await routeToNextContact(origin.id);
			const upstream = (await AbuseRepository.listRoutes(sent.reportId)).find((route) => route.verifiedEmail === UPSTREAM)!;
			expect(upstream.resolverProvenance).not.toHaveProperty("fallbackContacts");
			expect(upstream.resolverProvenance.ipRouteProvenance).toMatchObject({ bouncedRouteId: origin.id.toString(), bouncedEmails: [DEAD, "abuse@origin-asn.example"] });
		});

		describe("the one-off repair of IP routes that bounced with nowhere to go", () => {
			const BGP_STATE = "https://stat.ripe.net/data/bgp-state/data.json?resource=14.194.136.0%2F21";
			/** 14.194.139.244 as APNIC and RIPEstat publish it (2026-11-22). */
			const records: Record<string, unknown> = {
				[`https://rdap.test/ip/${IP}`]: { startAddress: "14.194.128.0", endAddress: "14.194.191.255", entities: [{ roles: ["abuse"], handle: "IRT-TATA-DOCOMO-IN", vcardArray: ["vcard", [["email", {}, "text", DEAD]]] }] },
				[`https://stat.ripe.net/data/network-info/data.json?resource=${IP}`]: { data: { asns: ["45820"], prefix: "14.194.136.0/21" } },
				"https://rdap.test/autnum/45820": { entities: [{ roles: ["abuse"], vcardArray: ["vcard", [["email", {}, "text", DEAD]]] }, { roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "TTSL-ISP DIVISION"]]] }] },
				[BGP_STATE]: { data: { bgp_state: [{ target_prefix: "14.194.136.0/21", path: [174, 6453, 4755, 45820] }] } },
				"https://rdap.test/autnum/4755": { entities: [{ roles: ["abuse"], handle: "IRT-TATACOMM-IN", vcardArray: ["vcard", [["email", {}, "text", UPSTREAM]]] }, { roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Tata Communications Limited"]]] }] },
			};
			const dependencies = (overrides: Record<string, unknown> = {}): ResolverDependencies => ({
				assertPublicHost: async () => undefined,
				rdapLocator: testRdapLocator,
				fetch: async (input) => {
					const payload = { ...records, ...overrides }[String(input)];
					return payload ? new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/rdap+json" } }) : new Response(null, { status: 404 });
				},
			});
			const repairsOf = async (deps: ResolverDependencies, ...sent: Array<{ route: { id: bigint } }>) =>
				(await repairIpRoutesWithoutFallback(deps)).filter((repair) => sent.some((one) => one.route.id.toString() === repair.routeId));

			test("re-resolves the address and moves the report on to the upstream; a rerun changes nothing", async () => {
				const sent = await sentReport("zealousvoice-repair.example.com", DEAD, undefined, undefined, infrastructureProvenance("zealousvoice-repair.example.com"));
				await bounceDead(sent);
				expect(await contactsOf(sent.reportId)).toEqual([DEAD]);

				expect(await repairsOf(dependencies(), sent)).toEqual([{ routeId: sent.route.id.toString(), verifiedEmail: DEAD, ip: IP, result: "routed", nextContact: UPSTREAM }]);
				const next = (await AbuseRepository.listRoutes(sent.reportId)).find((route) => route.verifiedEmail === UPSTREAM)!;
				expect(next.resolverProvenance).toMatchObject({ originatingIp: IP, ipRouteProvenance: { transit: { customerAsn: 45820, upstreamAsn: 4755 }, bouncedEmails: [DEAD] } });
				expect((await sendJobs(next.id)).map((job) => job.status)).toEqual(["queued"]);

				expect(await repairsOf(dependencies(), sent)).toEqual([{ routeId: sent.route.id.toString(), verifiedEmail: DEAD, ip: IP, result: "skipped", reason: "already_routed_on", nextContact: UPSTREAM }]);
				expect(await contactsOf(sent.reportId)).toEqual([DEAD, UPSTREAM]);
			});

			test("an address that publishes nothing new leaves the route as it was", async () => {
				const sent = await sentReport("zealous-nothing.example.com", DEAD, undefined, undefined, infrastructureProvenance("zealous-nothing.example.com"));
				await bounceDead(sent);
				expect(await repairsOf(dependencies({ [BGP_STATE]: { data: { bgp_state: [] } } }), sent))
					.toEqual([{ routeId: sent.route.id.toString(), verifiedEmail: DEAD, ip: IP, result: "skipped", reason: "no_other_contact" }]);
				expect(await contactsOf(sent.reportId)).toEqual([DEAD]);
			});

			test("leaves alone a domain's own contact and a route still resending after a temporary failure", async () => {
				const domainRoute = await sentReport("dead-registrar.example.com", "abuse@dead-registrar.example", undefined, undefined, { email: "abuse@dead-registrar.example", source: "domain_rdap" });
				await bounceDead(domainRoute);
				const greylisted = await sentReport("zealous-greylisted.example.com", DEAD, undefined, undefined, infrastructureProvenance("zealous-greylisted.example.com"));
				await ingestFetchedMail({ uid: nextUid++, source: icloudBounce(greylisted.outbound, DEAD, "451") }, config, { createIntakeSubmission: noIntake });
				await classifyReply((await inboundMail(greylisted.reportId)).find((message) => message.kind === "bounce")!.id);
				expect(await repairsOf(dependencies(), domainRoute, greylisted)).toEqual([
					{ routeId: domainRoute.route.id.toString(), verifiedEmail: "abuse@dead-registrar.example", result: "skipped", reason: "not_ip_derived" },
					{ routeId: greylisted.route.id.toString(), verifiedEmail: DEAD, ip: IP, result: "skipped", reason: "not_permanently_failed" },
				]);
				expect(await contactsOf(greylisted.reportId)).toEqual([DEAD]);
			});
		});
	});

	describe("the one-off repair of routes a misread delivery report ended", () => {
		/** `fixture` returned for `outbound`, stored the way ingestion stored Exchange's reports before: as a reply. */
		async function storedAsReply(sent: Awaited<ReturnType<typeof sentReport>>, outbound: Outbound, fixture = "office365-forwarded-recipients-not-found.eml") {
			const uid = nextUid++;
			// Each report has its own Message-ID; ingestion drops a repeated one.
			const rawMime = Buffer.from(deliveryReportFixture(fixture, outbound).toString("latin1").replace(/^Message-ID:\s*<[^>]+>/im, `Message-ID: <report-${uid}@mta.example>`), "latin1");
			const { messageId } = await persistInboundAbuseMail({
				kind: "reply", routeId: sent.route.id, reportId: sent.reportId, recipientAddresses: ["bounces@mail.phishing.support"],
				rawMime, mailbox: "relay-bounces", uidValidity: 1, uid,
			});
			return messageId;
		}
		/** How a replayed classification of a stale notice ended the route. */
		const endUncorrelated = (routeId: bigint) => AbuseRepository.transitionRouteStatus({ routeId, from: "awaiting_provider_reply", to: "provider_rejected", data: { reason: "uncorrelated_provider_bounce" } });
		const repairsOf = async (...sent: Array<{ route: { id: bigint } }>) => (await repairMisreadBounces()).filter((repair) => sent.some((one) => one.route.id.toString() === repair.routeId));

		test("settles the last send as permanently bounced, stores every report as a bounce, moves the report on, and finds nothing left on a rerun", async () => {
			const recipient = "ip.abuse@misread.example";
			const sent = await reportWithNextContact("misread-ndr.example.com", recipient);
			// Before: the classifier's "bounce" failed each send and resent it ...
			const first = await storedAsReply(sent, sent.outbound);
			await AbuseRepository.settleCorrelatedEmailBounce({ inboundMessageId: first, retry: true });
			const resent = await resendReport(sent);
			const second = await storedAsReply(sent, resent);
			// ... until a replayed classification of the first ended the route.
			await endUncorrelated(sent.route.id);

			expect(await repairsOf(sent)).toEqual([{ routeId: sent.route.id.toString(), verifiedEmail: recipient, result: "repaired", status: "delivery_failed", nextContact: NEXT_CONTACT }]);
			expect((await inboundMail(sent.reportId)).map((message) => [message.id, message.kind, message.classification])).toEqual([[first, "bounce", "bounce"], [second, "bounce", "bounce"]]);
			expect(await AbuseRepository.getMailMessage(resent.id)).toMatchObject({ status: "failed" });
			expect(await queuedSends(sent.route.id)).toEqual([]);
			const next = (await AbuseRepository.listRoutes(sent.reportId)).find((route) => route.verifiedEmail === NEXT_CONTACT)!;
			expect(next.resolverProvenance).toMatchObject({ reason: "fallback_after_permanent_bounce", bouncedRouteId: sent.route.id.toString() });
			expect((await sendJobs(next.id)).map((job) => job.status)).toEqual(["queued"]);
			expect((await AbuseRepository.listEvents(sent.reportId)).filter((event) => event.routeId === sent.route.id && event.eventType === "route.status_changed").slice(-2).map((event) => event.data))
				.toMatchObject([{ from: "provider_rejected", to: "awaiting_provider_reply", reason: "misread_bounce_reopened" }, { from: "awaiting_provider_reply", to: "delivery_failed" }]);

			expect(await repairsOf(sent)).toEqual([]);
			expect(await contactsOf(sent.reportId)).toEqual([recipient, NEXT_CONTACT]);
		});

		test("a target with no other contact: the route still fails as bounced, with nowhere to move on to", async () => {
			const sent = await sentReport("misread-sole-contact.example.com", "ip.abuse@sole.example");
			await storedAsReply(sent, sent.outbound);
			await endUncorrelated(sent.route.id);
			expect(await repairsOf(sent)).toEqual([{ routeId: sent.route.id.toString(), verifiedEmail: "ip.abuse@sole.example", result: "repaired", status: "delivery_failed" }]);
			expect(await contactsOf(sent.reportId)).toEqual(["ip.abuse@sole.example"]);
		});

		test("leaves alone what no report permanently failed the last send of: a relay refusal, a stale notice, a delay warning", async () => {
			const relay = await reportWithNextContact("legacy-relay.example.com", "abuse@legacy-relay.example");
			await ingestFetchedMail({ uid: nextUid++, source: icloudRelayRefusal(relay.outbound, "abuse@legacy-relay.example") }, config, { createIntakeSubmission: noIntake });
			await endUncorrelated(relay.route.id);

			const stale = await reportWithNextContact("stale-notice.example.com", "abuse@stale-notice.example");
			const old = await storedAsReply(stale, stale.outbound);
			await AbuseRepository.settleCorrelatedEmailBounce({ inboundMessageId: old, retry: true });
			await resendReport(stale);
			await endUncorrelated(stale.route.id);

			const delayed = await reportWithNextContact("delayed.example.com", "abuse@delayed.example");
			await storedAsReply(delayed, delayed.outbound, "gmail-delay-warning.eml");
			await endUncorrelated(delayed.route.id);

			const skipped = (sent: typeof relay) => ({ routeId: sent.route.id.toString(), verifiedEmail: sent.route.verifiedEmail, result: "skipped", reason: "no_permanent_failure_of_last_send", status: "provider_rejected" } as const);
			expect(await repairsOf(relay, stale, delayed)).toEqual([skipped(relay), skipped(stale), skipped(delayed)]);
			for (const sent of [relay, stale, delayed]) {
				expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "provider_rejected" });
				expect(await contactsOf(sent.reportId)).toEqual([sent.route.verifiedEmail]);
			}
			expect((await inboundMail(stale.reportId)).map((message) => message.kind)).toEqual(["reply"]);
		});
	});
});

describe("provider notifications", () => {
	async function netcraftRoute(confirmationId: string) {
		const sent = await sentReport("netcraft-target.example.com", "abuse@unused.example");
		const [target] = await AbuseRepository.listTargets(sent.reportId);
		const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
			routeKey: "provider:netcraft",
			providerRegistryKey: "netcraft",
			providerDisplayName: "Netcraft",
			routeType: "provider_submission",
			resolverProvenance: { source: "test" },
			resolutionSnapshot: { source: "test" },
			status: "verified",
		});
		const run = await AbuseRepository.createProviderRun({ routeId: route.id, providerPayload: {}, correlationKey: `netcraft:${route.id.toString()}` });
		await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId, submittedTargets: ["netcraft-target.example.com"] });
		return { reportId: sent.reportId, route };
	}

	test("Netcraft's analysis update attaches to the route whose receipt it links", async () => {
		const netcraft = await netcraftRoute("xArh9S0UgpbG6onJF7a965QeNKP0dTwj");
		const result = await ingestFetchedMail({
			uid: 577,
			source: eml([
				...icloudReceived("netcraft.com"),
				"From: report-updates@netcraft.com",
				"To: support@phishing.support",
				"Subject: We've updated the classification of your submission",
				"Message-ID: <20261027095053.0837865C@notothen.netcraft.com>",
			], "has been classified as malicious.\r\n   1. https://report.netcraft.com/submission/xArh9S0UgpbG6onJF7a965QeNKP0dTwj"),
		}, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ route: "reply" });
		const [update] = (await AbuseRepository.listMailForReport(netcraft.reportId)).filter((message) => message.routeId === netcraft.route.id);
		expect(update).toMatchObject({ kind: "notification" });
		await classifyReply(update!.id);
		expect(await AbuseRepository.getRoute(netcraft.route.id)).toMatchObject({ status: "submitted" });
		expect(await AbuseRepository.getMailMessage(update!.id)).toMatchObject({ classification: "acknowledged" });
	});

	test("Netcraft's finding of no threats is recorded as its rejection, without changing the route", async () => {
		const netcraft = await netcraftRoute("lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV");
		await ingestFetchedMail({
			uid: 578,
			source: eml([
				...icloudReceived("netcraft.com"),
				"From: report-updates@netcraft.com",
				"To: support@phishing.support",
				"Subject: We've finished analysing your submission",
				"Message-ID: <20261101055953.1234565C@notothen.netcraft.com>",
			], "The submission you made to report.netcraft.com on 01-Nov-2026 at 05:57 UTC has been automatically analysed, and no threats were found.\r\n   1. https://report.netcraft.com/submission/lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV"),
		}, config, { createIntakeSubmission: noIntake });
		const [update] = (await AbuseRepository.listMailForReport(netcraft.reportId)).filter((message) => message.routeId === netcraft.route.id);
		await classifyReply(update!.id);
		expect(await AbuseRepository.getMailMessage(update!.id)).toMatchObject({ kind: "notification", classification: "rejected", disposition: "provider_notification" });
		expect(await AbuseRepository.getRoute(netcraft.route.id)).toMatchObject({ status: "submitted" });
	});

	async function awsMail(uid: number, body: string, subject = "Your AWS Abuse Report [P01M7ZZZZZ]") {
		return ingestFetchedMail({
			uid,
			source: eml([
				...icloudReceived("aws.com"),
				'From: "AWS Trust & Safety" <trustandsafety@support.aws.com>',
				"To: support@phishing.support",
				`Subject: ${subject}`,
				`Message-ID: <aws-${uid}@support.aws.com>`,
			], body),
		}, config, { createIntakeSubmission: noIntake });
	}

	test("AWS's case mail naming our reference is a reply on that route, read by the reply classifier", async () => {
		const sent = await sentReport("aws-target.example.com", "abuse@unused.example");
		const [target] = await AbuseRepository.listTargets(sent.reportId);
		const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
			routeKey: "provider:aws_trust_safety",
			providerRegistryKey: "aws_trust_safety",
			providerDisplayName: "AWS Trust & Safety",
			routeType: "provider_submission",
			resolverProvenance: { source: "test" },
			resolutionSnapshot: { source: "test" },
			status: "verified",
		});
		const reference = `${sent.tag}-R${route.id.toString()}`;
		const run = await AbuseRepository.createProviderRun({ routeId: route.id, providerPayload: {}, correlationKey: `aws:${route.id.toString()}` });
		await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: reference, submittedTargets: ["aws-target.example.com"] });
		// A second report's route must not receive it.
		const unrelated = await sentReport("aws-other.example.com", "abuse@unused.example");

		const result = await awsMail(601, `Hello,\r\nCase number: 179517163600449\r\nPlease send us the full URL.\r\n\r\nYour original report:\r\nReference: ${reference}`);
		expect(result).toMatchObject({ route: "reply", reason: "stored_provider_reply" });
		const mail = (await AbuseRepository.listMailForReport(sent.reportId)).filter((message) => message.routeId === route.id);
		expect(mail).toMatchObject([{ kind: "reply", direction: "inbound", fromAddress: "trustandsafety@support.aws.com" }]);
		expect(await inboundMail(unrelated.reportId)).toEqual([]);
	});

	test("AWS's mail for a report we mailed to it before its form existed still matches by case tag", async () => {
		const sent = await sentReport("aws-old.example.com", "trustandsafety@support.aws.com");
		const result = await awsMail(602, `Thank you for your report.\r\n\r\nYour original report:\r\n[${sent.tag}] Abuse report for aws-old.example.com`);
		expect(result).toMatchObject({ route: "reply", reason: "stored_provider_reply" });
		expect(await inboundMail(sent.reportId)).toMatchObject([{ kind: "reply", routeId: sent.route.id }]);
	});

	test("AWS's mail naming nothing of ours attaches to nothing", async () => {
		const sent = await sentReport("aws-none.example.com", "trustandsafety@support.aws.com");
		await awsMail(603, "Your original report:\r\nReference: PS-ffffffffffff-R99999");
		expect(await inboundMail(sent.reportId)).toEqual([]);
	});

	test("Cloudflare's notification mail is left to its API correspondence", async () => {
		const result = await ingestFetchedMail({
			uid: 553,
			source: eml([
				...icloudReceived("notify.cloudflare.com"),
				'From: "Cloudflare Trust & Safety" <abuse@notify.cloudflare.com>',
				"To: support@phishing.support",
				"Subject: [ddfb9a8d1137a9e7]: Response to your Phishing report",
				"Message-ID: <HlqeUnBx@notify.cloudflare.com>",
			], "We have restricted access to the reported URL(s)."),
		}, config, { createIntakeSubmission: noIntake });
		expect(result).toEqual({ disposition: "terminal", route: "ignored", reason: "provider_api_correspondence" });
	});
});

describe("correlation helpers", () => {
	test("a reply subject that wraps ours in ticket text still repeats it", () => {
		expect(subjectRepeats("SIR24997722 - [Phishing Support] Abuse report for security.m365-microsoft.com", "[Phishing Support] Abuse report for security.m365-microsoft.com")).toBeTrue();
		expect(subjectRepeats("(autoresponse) [Phishing Support] Abuse report for raf-albania.com", "[Phishing Support] Abuse report for raf-albania.com")).toBeTrue();
		expect(subjectRepeats("Re: Abuse report for other.com", "[Phishing Support] Abuse report for raf-albania.com")).toBeFalse();
		expect(subjectRepeats("Re: hello", "Hello")).toBeFalse();
	});

	test("case tags are stable, short, and survive ticket prefixes", () => {
		expect(abuseCaseTag(373043025057681485n)).toBe("PS-50a7a280104d");
		expect(canonicalSubject("[Abuse@15727218] Re: AW: [Phishing Support] [PS-50a7a280104d] Abuse report for x.com"))
			.toBe("abuse report for x.com");
	});

	test("only the receiving server's own verdicts authenticate a sender", async () => {
		const parse = (lines: string[]) => simpleParser(eml(lines, "body"));
		expect(authenticatedSender(await parse([...icloudReceived("regtons.com"), "From: abuse@regtons.com"]), "icloud.com")).toBe("abuse@regtons.com");
		// DKIM signed by the parent organisation's other domain does not align.
		expect(authenticatedSender(await parse([
			"Received: from mx.icloud.com",
			"Authentication-Results: dkim-verifier.icloud.com; dkim=pass header.d=gransy.com",
			"Received-SPF: none",
			"Received: from sender",
			"From: abuse@regtons.com",
		]), "icloud.com")).toBeUndefined();
		expect(authenticatedSender(await parse([
			"Received: from mx.evil.example",
			"Authentication-Results: mx.evil.example; dmarc=pass header.from=regtons.com",
			"From: abuse@regtons.com",
		]), "icloud.com")).toBeUndefined();
	});
});
