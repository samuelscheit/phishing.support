import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { sendAbuseEmailRoute } from "../abuse/mail";
import { AbuseRepository } from "../abuse/repository";
import { getSubmissionDetails } from "./details";

useTemporaryDatabase();

const environmentNames = ["ABUSE_SMTP_FROM", "ABUSE_REPLY_DOMAIN", "ABUSE_TRACKING_TOKEN_SECRET"] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.ABUSE_SMTP_FROM = "support@phishing.support";
	process.env.ABUSE_REPLY_DOMAIN = "phishing.support";
	process.env.ABUSE_TRACKING_TOKEN_SECRET = "01234567890123456789012345678901";
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("legacy submission abuse-report read model", () => {
	test("includes standalone worker emails in the legacy submission Reports tab", async () => {
		const submissionId = 351387190816673794n;
		await SubmissionsEntity.create({
			id: submissionId,
			kind: "website",
			data: { kind: "website", website: { url: "https://shop.example.com/" } },
			dedupeKey: "legacy-website-abuse-details-test",
			status: "reported",
		});
		const request = await validateAbuseReportRequest({
			targets: ["shop.example.com"],
			allegationCategory: "phishing",
			description: "The captured page impersonates a trusted service and collects credentials.",
			observedUrls: [{ target: "shop.example.com", urls: ["https://shop.example.com/"] }],
			idempotencyKey: `legacy-website:${submissionId.toString()}`,
		});
		const abuseReport = await AbuseRepository.createReport({ request, reporter: {} });
		const [target] = await AbuseRepository.listTargets(abuseReport.reportId);
		if (!target) throw new Error("The test target was not persisted.");
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
		const run = await AbuseRepository.beginEmailDelivery({
			routeId: route.id,
			providerPayload: { source: "test" },
			correlationKey: `legacy-abuse-details-test:${submissionId.toString()}`,
		});
		if (!run) throw new Error("The test delivery run was not created.");
		await sendAbuseEmailRoute({
			reportId: abuseReport.reportId,
			routeId: route.id,
			runId: run.run.id,
			recipient: "abuse@provider.example.test",
			subject: "[Phishing Support] Abuse report for shop.example.com",
			body: "The captured page impersonates a trusted service and collects credentials.",
			correlationKey: run.run.correlationKey,
			transport: { sendMail: async () => ({ messageId: "smtp-test" }) },
		});

		const details = await getSubmissionDetails(submissionId.toString());
		expect(details?.reportThreads).toEqual([]);
		expect(details?.providerReports).toEqual([]);
		expect(details?.abuseMailReports).toHaveLength(1);
		expect(details?.abuseMailReports[0]).toMatchObject({
			provider: "Provider abuse desk",
			target: "shop.example.com",
			status: "sent",
			subject: "[Phishing Support] Abuse report for shop.example.com",
			textBody: "The captured page impersonates a trusted service and collects credentials.",
		});
		expect(details?.abuseMailReports[0]?.messageId).toMatch(/^<abuse-[a-f0-9]+@phishing\.support>$/);
	});
});
