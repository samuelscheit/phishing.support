import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { sendAbuseEmailRoute } from "../../mail/send";
import { AbuseRepository } from "../../repository";
import { sendEmail } from "../../worker/email";
import { routeFixture } from "../kit/testing";
import { executeProviderSubmission } from "../submission_execution";
import type { ProviderSubmissionProvider } from "../submission_contracts";
import { AWS_FORBIDDEN_FAILURE, repairAwsForbiddenRoutes } from "./forbidden_repair";
import { awsProvider } from "./index";

useTemporaryDatabase();

const saved = { from: process.env.SMTP_FROM, reply: process.env.REPLY_DOMAIN };
beforeEach(() => {
	process.env.SMTP_FROM = "support@phishing.support";
	process.env.REPLY_DOMAIN = "phishing.support";
});
afterAll(() => {
	if (saved.from === undefined) delete process.env.SMTP_FROM; else process.env.SMTP_FROM = saved.from;
	if (saved.reply === undefined) delete process.env.REPLY_DOMAIN; else process.env.REPLY_DOMAIN = saved.reply;
});

/** An AWS route the form's API answered with `failure` after the durable marker; nothing leaves the test. */
async function stuckRoute(failure: string, mailbox = "trustandsafety@support.aws.com") {
	const fixture = await routeFixture({ mailbox, providerName: "AWS" });
	const provider = { ...awsProvider, submit: async () => { throw new Error(failure); } } as ProviderSubmissionProvider;
	await executeProviderSubmission({ routeId: fixture.route.id, provider }).catch(() => undefined);
	expect((await AbuseRepository.getRoute(fixture.route.id))?.status).toBe("unknown_external_state");
	return fixture;
}

const fallbacksOf = async (reportId: bigint) => (await AbuseRepository.listRoutes(reportId)).filter((route) => route.routeKey.startsWith("email-fallback:"));

describe("repairAwsForbiddenRoutes", () => {
	test("settles exactly the 403 denials as refused, mails each mailbox once, and is idempotent", async () => {
		const denied = await stuckRoute(AWS_FORBIDDEN_FAILURE);
		const deniedOther = await stuckRoute(AWS_FORBIDDEN_FAILURE, "abuse@amazonaws.com");
		const other403 = await stuckRoute('AWS answered the report with HTTP 403: {"message":"Forbidden","reason":"x"}');
		const gateway = await stuckRoute("AWS answered the report with HTTP 502: <html>bad gateway</html>");

		const repaired = await repairAwsForbiddenRoutes();
		expect(repaired.map(({ routeId }) => routeId).sort()).toEqual([denied.route.id, deniedOther.route.id].map(String).sort());
		for (const { route, created } of [denied, deniedOther]) {
			expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "provider_rejected" });
			const [run] = await AbuseRepository.listProviderRunsForReport(created.reportId);
			expect(run).toMatchObject({ executionStatus: "failed", failureReason: 'AWS\'s API gateway denied the report before it was filed (HTTP 403): {"message":"Forbidden"}' });
			const [fallback, ...more] = await fallbacksOf(created.reportId);
			expect(more).toHaveLength(0);
			expect(fallback).toMatchObject({ routeType: "email", verifiedEmail: route.verifiedEmail, status: "verified" });
			expect(repaired.find(({ routeId }) => routeId === route.id.toString())?.fallbackRouteId).toBe(fallback!.id.toString());
		}
		for (const { route, created } of [other403, gateway]) {
			expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "unknown_external_state" });
			expect(await fallbacksOf(created.reportId)).toHaveLength(0);
		}

		expect(await repairAwsForbiddenRoutes()).toEqual([]);
		expect(await fallbacksOf(denied.created.reportId)).toHaveLength(1);
	});

	test("the fallback mail is a plain abuse mail to AWS's mailbox, not XARF", async () => {
		const { created } = await stuckRoute(AWS_FORBIDDEN_FAILURE);
		await repairAwsForbiddenRoutes();
		const [fallback] = await fallbacksOf(created.reportId);
		let raw = "";
		await sendEmail(fallback!.id, {
			markUnknownExternal: async () => undefined,
			createDraft: async () => ({ subject: "Phishing abuse", body: "Hello AWS Trust & Safety,\n\nA report.", recipientLabel: "AWS Trust & Safety" }),
			send: (params) => sendAbuseEmailRoute({ ...params, transport: { sendMail: async (message) => { raw = message.raw.toString("utf8"); return { messageId: "smtp" }; } } }),
		});
		const mail = await simpleParser(raw);
		expect(mail.to).toMatchObject({ text: "trustandsafety@support.aws.com" });
		expect(raw).not.toContain("feedback-report");
		expect(mail.text?.trim()).toBe("Hello AWS Trust & Safety,\n\nA report.");
		expect((await AbuseRepository.getRoute(fallback!.id))?.status).toBe("awaiting_provider_reply");
	});
});
