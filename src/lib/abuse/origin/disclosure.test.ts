import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { parseCloudflareOriginDisclosure, ensureOriginHostDisclosureJobs } from "./disclosure";

const RESPONSE = `Hello,

Your abuse report has been forwarded to the website owner.
We have also forwarded this report to the relevant hosting provider.
The host for the reported domain is:
Informaten GbR
abuse@informaten.com
You may use this information to follow up directly with the hosting provider.
To respond to this issue, please reply to abusereply@cloudflare.com.`;

describe("Cloudflare origin-host disclosure", () => {
	test("extracts only the mailbox and label inside the explicit host block", () => {
		expect(parseCloudflareOriginDisclosure(RESPONSE)).toEqual({ recipient: "abuse@informaten.com", providerLabel: "Informaten GbR" });
		expect(parseCloudflareOriginDisclosure("Reply to abusereply@cloudflare.com.")).toBeUndefined();
		expect(parseCloudflareOriginDisclosure("The host for the reported domain is:\nabuse@cloudflare.com\nYou may use this information")).toBeUndefined();
	});

	describe("durable backfill", () => {
		useTemporaryDatabase();

		test("queues each stored disclosure once for its entire lifetime", async () => {
			const request = await validateAbuseReportRequest({ targets: ["login.example.com"], allegationCategory: "phishing", description: "Credential phishing." });
			const report = await AbuseRepository.createReport({ request, reporter: {} });
			const [target] = await AbuseRepository.listTargets(report.reportId);
			const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
				routeKey: "provider:cloudflare",
				providerRegistryKey: "cloudflare",
				providerDisplayName: "Cloudflare Abuse",
				routeType: "provider_submission",
				resolverProvenance: {},
				resolutionSnapshot: {},
				status: "verified",
			});
			await AbuseRepository.recordProviderCorrespondence({
				route,
				messages: [{ id: "provider-message-1", subject: "[0123456789abcdef]: Response", body: RESPONSE, sentAt: new Date(), from: "Cloudflare" }],
			});
			expect(await ensureOriginHostDisclosureJobs()).toBe(1);
			expect(await ensureOriginHostDisclosureJobs()).toBe(1);
			const jobs: Array<{ jobType: string; dedupeKey: string | null }> = [];
			while (true) {
				const job = await AbuseRepository.claimNextJob("test", 60_000);
				if (!job) break;
				jobs.push(job);
				await AbuseRepository.completeJob(job.id, "test");
			}
			expect(jobs.filter(({ jobType }) => jobType === "report_origin_host")).toHaveLength(1);
			expect(await ensureOriginHostDisclosureJobs()).toBe(1);
			const replay = await AbuseRepository.claimNextJob("test", 60_000, { jobTypes: ["report_origin_host"] });
			expect(replay).toBeUndefined();
		});
	});
});
