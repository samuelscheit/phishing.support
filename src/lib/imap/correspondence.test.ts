import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { simpleParser } from "mailparser";

import { getDb } from "../db";
import { SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { sendAbuseEmailRoute } from "../abuse/mail";
import { abuseCaseTag, authenticatedSender, canonicalSubject, deliveryFailure, subjectRepeats } from "../abuse/mail/correlation";
import { AbuseRepository } from "../abuse/repository";
import { abuseJobs } from "../abuse/schema";
import { classifyReply } from "../abuse/worker/mail";
import { ingestFetchedMail, type MailIngestConfig } from "./ingest";

useTemporaryDatabase();

const config: MailIngestConfig = { mailbox: "phishing.support", uidValidity: 1700000000, intakeAddress: "report@phishing.support" };
const environmentNames = ["SMTP_FROM", "REPLY_DOMAIN"] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.SMTP_FROM = "support@phishing.support";
	process.env.REPLY_DOMAIN = "phishing.support";
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const noIntake = async () => {
	throw new Error("Intake must not run for this message.");
};

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
async function sentReport(target: string, recipient: string, subject?: string, submissionId?: bigint) {
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
		recipient,
		subject: subject ?? `[Phishing Support] [${abuseCaseTag(report.reportId)}] Abuse report for ${target}`,
		body: `Case details: https://phishing.support/submissions/${(submissionId ?? report.reportId).toString()}`,
		correlationKey: delivery.run.correlationKey,
		transport: { sendMail: async () => ({ messageId: "smtp-test" }) },
	});
	await AbuseRepository.settleEmailDelivery({ runId: delivery.run.id, expectedRunStatus: "starting", expectedRouteStatus: "running", outcome: "sent" });
	const outbound = await AbuseRepository.getOutboundMailForRun(delivery.run.id);
	if (!outbound?.messageId) throw new Error("Test outbound message was not persisted.");
	return { reportId: report.reportId, route, outbound, tag: abuseCaseTag(report.reportId) };
}

async function inbound(reportId: bigint) {
	return (await AbuseRepository.listMailForReport(reportId)).filter((message) => message.direction === "inbound");
}

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
		expect(await inbound(sent.reportId)).toMatchObject([{ kind: "reply", fromAddress: "abuse@regtons.com" }]);
		expect(await inbound(other.reportId)).toEqual([]);
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
		expect(await inbound(sent.reportId)).toHaveLength(1);
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
		expect(await inbound(sent.reportId)).toHaveLength(1);
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
		expect(await inbound(sent.reportId)).toEqual([]);
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
		expect(await inbound(sent.reportId)).toEqual([]);
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
		expect(await inbound(sent.reportId)).toMatchObject([{ kind: "reply" }]);
	});
});

describe("delivery-status notifications", () => {
	function icloudBounce(outbound: { messageId: string | null; replyAddress: string | null }, recipient: string, status: string) {
		const boundary = "bounce-boundary";
		return Buffer.from([
			...icloudReceived("icloud.com"),
			'From: "Mail Delivery System" <mailer-daemon@icloud.com>',
			"To: support@phishing.support",
			"Subject: Undelivered Mail Returned to Sender",
			"Auto-Submitted: auto-replied",
			"Message-Id: <20261020141158.A82443000E4B@outbound.qs.icloud.com>",
			"MIME-Version: 1.0",
			`Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
			"",
			`--${boundary}`,
			"Content-Type: text/plain",
			"",
			`<${recipient}>: host 127.0.0.1 said: ${status} Message rejected due to local policy`,
			`--${boundary}`,
			"Content-Type: message/delivery-status",
			"",
			"Reporting-MTA: dns; outbound.qs.icloud.com",
			"",
			`Original-Recipient: rfc822;${recipient}`,
			"Action: failed",
			`Status: ${status.replace(/^(\d)(\d\d)$/, "$1.7.1")}`,
			`Diagnostic-Code: smtp; ${status} 5.7.1 [CS101] Message rejected due to local policy`,
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

	test("parses who rejected which of our messages", async () => {
		const parsed = await simpleParser(icloudBounce({ messageId: "<abuse-d984c10d2a49288f@phishing.support>", replyAddress: "abuse-ef16@phishing.support" }, "iarpoc@newfold.com", "550"));
		expect(deliveryFailure(parsed)).toMatchObject({ recipients: ["iarpoc@newfold.com"], messageIds: ["<abuse-d984c10d2a49288f@phishing.support>"] });
	});

	test("a permanent rejection marks the route undeliverable without resending", async () => {
		const sent = await sentReport("oxwitik.com", "iarpoc@newfold.com");
		const result = await ingestFetchedMail({ uid: 538, source: icloudBounce(sent.outbound, "iarpoc@newfold.com", "550") }, config, { createIntakeSubmission: noIntake });
		expect(result).toMatchObject({ route: "reply" });
		const [bounce] = await inbound(sent.reportId);
		expect(bounce).toMatchObject({ kind: "bounce", references: [sent.outbound.messageId] });
		await classifyReply(bounce!.id);
		expect(await AbuseRepository.getRoute(sent.route.id)).toMatchObject({ status: "delivery_failed" });
		expect(await AbuseRepository.getMailMessage(bounce!.id)).toMatchObject({ classification: "bounce" });
		const resends = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, sent.route.id)).all().filter((job) => job.jobType === "send_email");
		expect(resends).toEqual([]);
	});

	test("a temporary failure queues one resend with the same identity", async () => {
		const sent = await sentReport("greylisted.example.com", "abuse@greylist.example");
		await ingestFetchedMail({ uid: 539, source: icloudBounce(sent.outbound, "abuse@greylist.example", "451") }, config, { createIntakeSubmission: noIntake });
		const [bounce] = await inbound(sent.reportId);
		await classifyReply(bounce!.id);
		const resends = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, sent.route.id)).all().filter((job) => job.jobType === "send_email");
		expect(resends).toHaveLength(1);
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
