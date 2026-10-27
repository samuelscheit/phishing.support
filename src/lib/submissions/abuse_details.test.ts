import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import sharp from "sharp";

import { SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { sendAbuseEmailRoute } from "../abuse/mail";
import { AbuseRepository } from "../abuse/repository";
import { reportConfirmedEmailPhishing, reportConfirmedWebsitePhishing } from "../abuse/submission_reports";
import { getSubmissionDetails } from "./details";

useTemporaryDatabase();

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

async function createWebsiteReport(submissionId: bigint) {
	await SubmissionsEntity.create({
		id: submissionId,
		kind: "website",
		data: { kind: "website", website: { url: "https://shop.example.com/" } },
		dedupeKey: `website-report-details-test:${submissionId.toString()}`,
		status: "reported",
	});
	const report = await reportConfirmedWebsitePhishing({
		submissionId,
		urls: ["https://shop.example.com/"],
		analysisText: "The captured page impersonates a trusted service and collects credentials.",
		reporter: {},
	});
	const [target] = await AbuseRepository.listTargets(report.reportId);
	if (!target) throw new Error("The test target was not persisted.");
	return { report, target };
}

describe("submission report read model", () => {
	test("returns no report for a submission that was never confirmed", async () => {
		const submissionId = 351387190816673790n;
		await SubmissionsEntity.create({ id: submissionId, kind: "website", data: { kind: "website", website: { url: "https://benign.example.com/" } }, dedupeKey: "unreported" });
		expect((await getSubmissionDetails(submissionId.toString()))?.report).toBeNull();
	});

	test("shows a sent abuse email and its provider reply on the same route", async () => {
		const submissionId = 351387190816673794n;
		const { report, target } = await createWebsiteReport(submissionId);
		const route = await AbuseRepository.upsertResolvedRoute(target.id, {
			routeKey: "email:abuse@provider.example.test",
			providerRegistryKey: "email:provider.example.test",
			providerDisplayName: "Provider abuse desk",
			routeType: "email",
			verifiedEmail: "abuse@provider.example.test",
			resolverProvenance: { source: "test" },
			resolutionSnapshot: { source: "test" },
			status: "verified",
		});
		const run = await AbuseRepository.beginEmailDelivery({ routeId: route.id, providerPayload: { source: "test" }, correlationKey: `details-test:${submissionId.toString()}` });
		if (!run) throw new Error("The test delivery run was not created.");
		await sendAbuseEmailRoute({
			reportId: report.reportId,
			routeId: route.id,
			runId: run.run.id,
			recipient: "abuse@provider.example.test",
			subject: "[Phishing Support] Abuse report for shop.example.com",
			body: "Please investigate the credential-harvesting page.",
			correlationKey: run.run.correlationKey,
			transport: { sendMail: async () => ({ messageId: "smtp-test" }) },
		});
		await AbuseRepository.settleEmailDelivery({ runId: run.run.id, expectedRunStatus: "starting", expectedRouteStatus: "running", outcome: "sent" });
		const outbound = await AbuseRepository.getOutboundMailForRun(run.run.id);
		await AbuseRepository.persistInboundMailWithArtifacts({
			reportId: report.reportId,
			routeId: route.id,
			kind: "reply",
			fromAddress: "abuse@provider.example.test",
			toAddresses: [outbound!.replyAddress!],
			subject: "Re: abuse report",
			textBody: "The site was suspended.",
			messageId: "<reply@provider.example.test>",
			inReplyTo: outbound!.messageId!,
			mailbox: "INBOX",
			uidValidity: 1,
			uid: 7,
			rawMime: { name: "reply.eml", buffer: Buffer.from("From: abuse@provider.example.test\r\n\r\nThe site was suspended.") },
			attachments: [],
		});

		const details = await getSubmissionDetails(submissionId.toString());
		expect(details?.report?.status).toBe("waiting_provider");
		const mailRoute = details?.report?.routes.find((item) => item.routeType === "email");
		expect(mailRoute).toMatchObject({ provider: "Provider abuse desk", target: "shop.example.com", status: "awaiting_provider_reply", body: null });
		expect(mailRoute?.messages.map((message) => [message.direction, message.status])).toEqual([["outbound", "sent"], ["inbound", "received"]]);
		expect(mailRoute?.messages[0]?.messageId).toMatch(/^<abuse-[a-f0-9]+@phishing\.support>$/);
		const rawId = mailRoute?.messages[1]?.rawArtifactId;
		expect(details?.report?.artifacts.find((artifact) => artifact.id === rawId)).toMatchObject({ name: "reply.eml", kind: "inbound_mail_mime" });
		expect(JSON.stringify(details?.report?.artifacts)).not.toContain("blob");
	});

	test("shows pinned provider text and outcomes without exposing provider payloads", async () => {
		const submissionId = 352342673387950094n;
		const { target } = await createWebsiteReport(submissionId);
		const submittedRoute = await AbuseRepository.upsertResolvedRoute(target.id, {
			routeKey: "provider_submission:google_safe_browsing:test",
			providerRegistryKey: "google_safe_browsing",
			providerDisplayName: "Google Safe Browsing",
			routeType: "provider_submission",
			providerDefinitionVersion: "test-v1",
			providerDefinitionHash: "a".repeat(64),
			resolverProvenance: { source: "test" },
			resolutionSnapshot: { source: "test" },
			status: "verified",
		});
		const submitted = await AbuseRepository.beginProviderExecution({
			routeId: submittedRoute.id,
			providerPayload: { providerNarrativeVersion: 1, report: { explanation: "The submitted Google report explains the credential-harvesting evidence.", privateToken: "do-not-expose" } },
			correlationKey: `google-safe-browsing:${submissionId.toString()}`,
			expectedStatus: "verified",
		});
		if (!submitted) throw new Error("The submitted provider run was not created.");
		expect(await AbuseRepository.prepareProviderSubmission(submitted.run.id)).toBeTrue();
		expect(await AbuseRepository.settleProviderRun({
			runId: submitted.run.id,
			executionStatus: "completed",
			routeStatus: "submitted",
			confirmationId: "google-confirmation-123",
			confirmationText: "The URL was submitted.",
			submittedTargets: [target.normalizedTarget],
		})).toBeTrue();

		const unresolvedRoute = await AbuseRepository.upsertResolvedRoute(target.id, {
			routeKey: "provider_submission:cloudflare:test",
			providerRegistryKey: "cloudflare",
			providerDisplayName: "Cloudflare Abuse",
			routeType: "provider_submission",
			providerDefinitionVersion: "test-v1",
			providerDefinitionHash: "b".repeat(64),
			resolverProvenance: { source: "test" },
			resolutionSnapshot: { source: "test" },
			status: "verified",
		});
		const unresolved = await AbuseRepository.beginProviderExecution({
			routeId: unresolvedRoute.id,
			providerPayload: { providerNarrativeVersion: 1, form: { justification: "The Cloudflare report explains the impersonation evidence.", privateCookie: "do-not-expose" } },
			correlationKey: `cloudflare:${submissionId.toString()}`,
			expectedStatus: "verified",
		});
		if (!unresolved) throw new Error("The unresolved provider run was not created.");
		expect(await AbuseRepository.prepareProviderSubmission(unresolved.run.id)).toBeTrue();
		await AbuseRepository.markUnknownExternalState({ routeId: unresolvedRoute.id, runId: unresolved.run.id, error: "The provider response could not be verified.", reason: "test_unknown_external_state" });

		const details = await getSubmissionDetails(submissionId.toString());
		expect(details?.report?.routes).toEqual(expect.arrayContaining([
			expect.objectContaining({
				provider: "Google Safe Browsing",
				status: "submitted",
				bodySource: "prepared",
				body: "The submitted Google report explains the credential-harvesting evidence.",
				observedUrls: ["https://shop.example.com/"],
				submittedTargets: ["shop.example.com"],
				confirmationId: "google-confirmation-123",
			}),
			expect.objectContaining({
				provider: "Cloudflare Abuse",
				status: "unknown_external_state",
				body: "The Cloudflare report explains the impersonation evidence.",
				error: "The provider route did not complete safely.",
			}),
		]));
		// One provider stuck in an unknown state must not hide the confirmed submission.
		expect(details?.report?.status).toBe("partially_submitted");
		expect(JSON.stringify(details)).not.toContain("do-not-expose");
	});

	test("shows a provider-specific preview instead of an unprepared or analysis-only draft", async () => {
		const submissionId = 352342673387950095n;
		const { report, target } = await createWebsiteReport(submissionId);
		const persisted = await AbuseRepository.getReport(report.reportId);
		const route = await AbuseRepository.upsertResolvedRoute(target.id, {
			routeKey: "provider_submission:netcraft:preview",
			providerRegistryKey: "netcraft",
			providerDisplayName: "Netcraft",
			routeType: "provider_submission",
			providerDefinitionVersion: "test-v1",
			providerDefinitionHash: "c".repeat(64),
			resolverProvenance: { source: "test" },
			resolutionSnapshot: { source: "test" },
			status: "verified",
		});
		const unprepared = (await getSubmissionDetails(submissionId.toString()))?.report?.routes.find((item) => item.provider === "Netcraft");
		expect(unprepared).toMatchObject({ status: "verified", bodySource: "preview" });
		expect(unprepared?.body).toContain("Netcraft");
		expect(unprepared?.body).not.toContain(persisted!.description);

		await AbuseRepository.beginProviderExecution({
			routeId: route.id,
			providerPayload: { report: { reason: persisted!.description }, privateField: "must-not-be-rendered" },
			correlationKey: `analysis-only:${submissionId.toString()}`,
			expectedStatus: "verified",
		});
		const analysisOnly = await getSubmissionDetails(submissionId.toString());
		const historical = analysisOnly?.report?.routes.find((item) => item.provider === "Netcraft");
		expect(historical).toMatchObject({ status: "running", bodySource: "historical" });
		expect(historical?.body).not.toContain(persisted!.description);
		expect(JSON.stringify(analysisOnly)).not.toContain("must-not-be-rendered");
	});

	test("files a confirmed email as one report: the message for mail providers and the sending IP for its abuse contact", async () => {
		const submissionId = 372818777718394942n;
		await SubmissionsEntity.create({ id: submissionId, kind: "email", data: { kind: "email" }, dedupeKey: "email-report-details" });
		const screenshot = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } }).png().toBuffer();
		const eml = "From: Wallet <notice@express.example.com>\r\nTo: [redacted]\r\nSubject: Verify\r\n\r\nVerify your wallet.";
		const first = await reportConfirmedEmailPhishing({
			submissionId,
			analysisText: "The email impersonates a wallet provider.",
			redactedEml: eml,
			sendingIp: "199.102.178.225",
			screenshotPng: screenshot,
			reporter: { reporterIp: "8.8.8.8" },
		});
		const replay = await reportConfirmedEmailPhishing({ submissionId, analysisText: "A different retry analysis.", redactedEml: eml, reporter: {} });
		expect(replay).toMatchObject({ reportId: first.reportId, created: false });

		const targets = await AbuseRepository.listTargets(first.reportId);
		expect(targets.map((item) => [item.normalizedTarget, item.targetType])).toEqual([["phishing-email", "email"], ["199.102.178.225", "ip"]]);
		const evidence = await AbuseRepository.listArtifacts(first.reportId, ["user_evidence_original"]);
		expect(evidence.map((item) => [item.name, item.mimeType])).toEqual([["phishing-email.eml", "message/rfc822"], ["phishing-email.png", "image/png"]]);
		expect(evidence[0]?.blob.toString()).toBe(eml);
		expect((await getSubmissionDetails(submissionId.toString()))?.report).toMatchObject({ status: "accepted" });
	});

	test("rejects a private sending IP instead of routing it", async () => {
		const submissionId = 372818777718394943n;
		await SubmissionsEntity.create({ id: submissionId, kind: "email", data: { kind: "email" }, dedupeKey: "email-private-ip" });
		const created = await reportConfirmedEmailPhishing({ submissionId, analysisText: "Phishing.", redactedEml: "Subject: x\r\n\r\nbody", sendingIp: "10.0.0.5", reporter: {} });
		expect((await AbuseRepository.listTargets(created.reportId)).map((item) => item.targetType)).toEqual(["email"]);
	});
});
