import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { parse } from "@xarf/xarf";
import { serviceUserAgent } from "../../network/service_identity";
import { simpleParser } from "mailparser";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { sendAbuseEmailRoute } from "../mail/send";
import { AbuseRepository } from "../repository";
import { sendEmail } from "../worker/email";
import { digitalOceanProvider } from "./digitalocean";
import { dynadotProvider } from "./dynadot";
import { awsProvider } from "./aws";
import { submitAwsSubmission } from "./aws/submission";
import { PNG, routeFixture, TARGET } from "./kit/testing";
import { executeProviderSubmission } from "./submission_execution";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError, type ProviderSubmissionProvider, type ProviderSubmissionSuccess } from "./submission_contracts";

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

/** The DigitalOcean provider whose one request answers as `submit` does; nothing leaves the test. */
const answering = (submit: () => Promise<ProviderSubmissionSuccess>): ProviderSubmissionProvider => ({ ...digitalOceanProvider, submit } as ProviderSubmissionProvider);

async function doRoute() {
	const fixture = await routeFixture({ mailbox: "abuse@digitalocean.com", providerName: "DigitalOcean", screenshot: PNG, provenance: { source: "domain_infrastructure_ip", originatingIp: "164.90.1.2", originatingDomain: TARGET } });
	await AbuseRepository.saveRouteArtifactOnce({ reportId: fixture.created.reportId, routeId: fixture.route.id, name: "origin-host-evidence.txt", kind: "origin_host_evidence", mimeType: "text/plain", buffer: Buffer.from("sweep facts\n") });
	return fixture;
}

const fallbackOf = async (reportId: bigint) => (await AbuseRepository.listRoutes(reportId)).filter((route) => route.routeKey.startsWith("email-fallback:"));

describe("email fallback", () => {
	test("a refused form report goes to the mailbox as XARF, once, with the route's files", async () => {
		const { created, route } = await doRoute();
		const result = await executeProviderSubmission({ routeId: route.id, provider: answering(async () => { throw new ProviderSubmissionRejectedError("DigitalOcean refused the report (HTTP 422)"); }) });
		expect(result.outcome).toBe("provider_rejected");
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("provider_rejected");
		const [fallback, ...more] = await fallbackOf(created.reportId);
		expect(more).toHaveLength(0);
		expect(fallback).toMatchObject({
			routeKey: "email-fallback:provider_submission:digitalocean:contact",
			routeType: "email",
			verifiedEmail: "abuse@digitalocean.com",
			status: "verified",
			targetId: route.targetId,
		});
		expect(fallback!.resolverProvenance).toMatchObject({ source: "domain_infrastructure_ip", originatingIp: "164.90.1.2", emailFallbackFromRouteId: route.id.toString(), emailFallbackReason: "provider_rejected" });
		expect((await AbuseRepository.listRouteArtifacts(fallback!.id, ["origin_host_evidence"])).map(({ name }) => name)).toEqual(["origin-host-evidence.txt"]);

		// A replay of the settled job changes nothing.
		await executeProviderSubmission({ routeId: route.id, provider: digitalOceanProvider });
		expect(await fallbackOf(created.reportId)).toHaveLength(1);

		let raw = "";
		await sendEmail(fallback!.id, {
			markUnknownExternal: async () => undefined,
			createDraft: async () => ({ subject: `Phishing abuse: ${TARGET}`, body: "Hello DigitalOcean Abuse Team,\n\nA report.", recipientLabel: "DigitalOcean" }),
			send: (params) => sendAbuseEmailRoute({ ...params, transport: { sendMail: async (message) => { raw = message.raw.toString("utf8"); return { messageId: "smtp" }; } } }),
		});
		expect(raw).toMatch(/^Content-Type: multipart\/report; report-type=feedback-report;/m);
		const mail = await simpleParser(raw);
		expect(mail.text?.trim()).toBe("Hello DigitalOcean Abuse Team,\n\nA report.");
		expect(raw).toContain(`Content-Type: message/feedback-report\r\nContent-Transfer-Encoding: 7bit\r\nContent-Disposition: inline\r\n\r\nFeedback-Type: xarf\r\nUser-Agent: ${serviceUserAgent}\r\nVersion: 1`);
		expect(raw).toContain("Content-Type: application/json; name=xarf.json\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=xarf.json");
		// The evidence rides inside the report, not beside it.
		expect(mail.attachments.map(({ filename }) => filename).filter(Boolean)).toEqual(["xarf.json"]);
		const json = JSON.parse(mail.attachments.find(({ filename }) => filename === "xarf.json")!.content.toString("utf8"));
		expect(parse(json).errors).toEqual([]);
		expect(json).toMatchObject({
			xarf_version: "4.2.0",
			category: "content",
			type: "phishing",
			source_identifier: "164.90.1.2",
			source_port: 443,
			url: `https://${TARGET}/signin`,
			domain: TARGET,
			target_brand: "examplebank.com",
			cloned_site: "https://www.examplebank.com/",
			reporter: { org: "Phishing Support", contact: "support@phishing.support", domain: "phishing.support" },
			description: `Phishing abuse: ${TARGET}`,
		});
		expect(json.evidence.map(({ description }: { description: string }) => description).sort()).toEqual(["origin-host-evidence.txt", "website.png"]);
		expect(json.evidence.find(({ description }: { description: string }) => description === "website.png")).toMatchObject({ content_type: "image/png", payload: PNG.toString("base64"), size: PNG.byteLength });
		expect((await AbuseRepository.getRoute(fallback!.id))?.status).toBe("awaiting_provider_reply");
	});

	test("a report that needs a person or has nothing to draft still goes by mail; a filed or ambiguous one does not", async () => {
		const human = await doRoute();
		await executeProviderSubmission({ routeId: human.route.id, provider: answering(async () => { throw new ProviderSubmissionNeedsHumanError("blocked"); }) });
		expect(await fallbackOf(human.created.reportId)).toHaveLength(1);

		const filed = await doRoute();
		expect((await executeProviderSubmission({ routeId: filed.route.id, provider: answering(async () => ({ confirmationId: "x", submittedTargets: [TARGET] })) })).outcome).toBe("submitted");
		expect(await fallbackOf(filed.created.reportId)).toHaveLength(0);

		const lost = await doRoute();
		await executeProviderSubmission({ routeId: lost.route.id, provider: answering(async () => { throw new Error("socket hang up"); }) }).catch(() => undefined);
		expect(await fallbackOf(lost.created.reportId)).toHaveLength(0);
	});

	test("AWS's API Gateway denial settles as refused and goes to AWS's mailbox", async () => {
		const { created, route } = await routeFixture({ mailbox: "trustandsafety@support.aws.com", providerName: "AWS" });
		const denied = async () => new Response('{"message":"Forbidden"}', { status: 403, headers: { "x-amzn-errortype": "ForbiddenException" } });
		const provider = { ...awsProvider, submit: (context) => submitAwsSubmission(context, { fetch: denied }) } as ProviderSubmissionProvider;
		expect((await executeProviderSubmission({ routeId: route.id, provider })).outcome).toBe("provider_rejected");
		expect(await fallbackOf(created.reportId)).toMatchObject([{ routeType: "email", verifiedEmail: "trustandsafety@support.aws.com", status: "verified" }]);
	});

	test("a provider without an email fallback keeps its refusal", async () => {
		const { created, route } = await routeFixture({ mailbox: "abuse@dynadot.com", providerName: "Dynadot" });
		await executeProviderSubmission({ routeId: route.id, provider: { ...dynadotProvider, prepareSubmission: async () => ({ outcome: "insufficient_evidence", reason: "test" }) } });
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("insufficient_evidence");
		expect(await fallbackOf(created.reportId)).toHaveLength(0);
	});
});
