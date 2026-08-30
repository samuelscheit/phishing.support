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
	async function createLegacyWebsiteReport(submissionId: bigint) {
		await SubmissionsEntity.create({
			id: submissionId,
			kind: "website",
			data: { kind: "website", website: { url: "https://shop.example.com/" } },
			dedupeKey: `legacy-website-abuse-details-test:${submissionId.toString()}`,
			status: "reported",
		});
		const request = await validateAbuseReportRequest({
			targets: ["shop.example.com"],
			allegationCategory: "phishing",
			description: "The captured page impersonates a trusted service and collects credentials.",
			observedUrls: [{ target: "shop.example.com", urls: ["https://shop.example.com/"] }],
			idempotencyKey: `legacy-website:${submissionId.toString()}`,
		});
		const report = await AbuseRepository.createReport({ request, reporter: {} });
		const [target] = await AbuseRepository.listTargets(report.reportId);
		if (!target) throw new Error("The test target was not persisted.");
		return { report, target };
	}

	test("includes standalone worker emails in the legacy submission Reports tab", async () => {
		const submissionId = 351387190816673794n;
		const { report: abuseReport, target } = await createLegacyWebsiteReport(submissionId);
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

	test("includes direct provider outcomes and the pinned report text without exposing provider payloads", async () => {
		const submissionId = 352342673387950094n;
		const { report, target } = await createLegacyWebsiteReport(submissionId);
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
			providerPayload: { report: { explanation: "The submitted Google report explains the credential-harvesting evidence.", privateToken: "do-not-expose" } },
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
			finalUrl: "https://safebrowsing.google.com/safebrowsing/report_phish/?url=https%3A%2F%2Fshop.example.com%2F",
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
			providerPayload: { form: { justification: "The Cloudflare report explains the TikTok impersonation evidence.", privateCookie: "do-not-expose" } },
			correlationKey: `cloudflare:${submissionId.toString()}`,
			expectedStatus: "verified",
		});
		if (!unresolved) throw new Error("The unresolved provider run was not created.");
		expect(await AbuseRepository.prepareProviderSubmission(unresolved.run.id)).toBeTrue();
		await AbuseRepository.markUnknownExternalState({
			routeId: unresolvedRoute.id,
			runId: unresolved.run.id,
			error: "The provider response could not be verified.",
			reason: "test_unknown_external_state",
		});

		const details = await getSubmissionDetails(submissionId.toString());
		expect(details?.abuseProviderReports).toEqual(expect.arrayContaining([
			expect.objectContaining({
				provider: "Google Safe Browsing",
				status: "submitted",
				body: "The submitted Google report explains the credential-harvesting evidence.",
				observedUrls: ["https://shop.example.com/"],
				submittedTargets: ["shop.example.com"],
				confirmationId: "google-confirmation-123",
				confirmationText: "The URL was submitted.",
			}),
			expect.objectContaining({
				provider: "Cloudflare Abuse",
				status: "unknown_external_state",
				body: "The Cloudflare report explains the TikTok impersonation evidence.",
				error: "The provider route did not complete safely.",
			}),
		]));
		expect(JSON.stringify(details)).not.toContain("do-not-expose");
		expect(details?.abuseMailReports).toEqual([]);
		expect(details?.providerReports).toEqual([]);
		expect(report.created).toBeTrue();
	});
});
