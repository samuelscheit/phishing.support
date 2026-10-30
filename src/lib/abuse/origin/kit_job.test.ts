import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { SubmissionsEntity } from "../../db/entities";
import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { abuseJobs } from "../schema";
import { analyzeKitSibling, discoverKitSiblings, ensureKitSiblingDiscoveryJobs } from "./kit_job";

describe("all-case kit sibling discovery", () => {
	useTemporaryDatabase();

	test("backfills one lifetime job and opens every exact-hash candidate as a normal website submission", async () => {
		const submissionId = 420000000000000001n;
		await SubmissionsEntity.create({
			id: submissionId,
			kind: "website",
			data: { kind: "website", website: { url: "https://login.example.com/" } },
			dedupeKey: "website-login.example.com",
			status: "reported",
			source: "https://login.example.com/",
		});
		const request = await validateAbuseReportRequest({
			targets: ["login.example.com"],
			allegationCategory: "phishing",
			description: "Confirmed credential phishing.",
			observedUrls: [{ target: "login.example.com", urls: ["https://login.example.com/"] }],
		});
		const report = await AbuseRepository.createReport({ request, reporter: { reporterCountry: "DE" }, submissionId });
		expect(await ensureKitSiblingDiscoveryJobs()).toBe(1);
		expect(await ensureKitSiblingDiscoveryJobs()).toBe(1);
		const jobs = await (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "discover_kit_siblings")).all();
		expect(jobs).toHaveLength(1);

		const result = await discoverKitSiblings({ reportId: report.reportId }, {
			findCandidates: async () => ({
				fingerprints: [{ sha256: "a".repeat(64), mimeType: "text/css", url: "https://login.example.com/kit.css", size: 1234 }],
				candidates: [
					{ domain: "one.example.net", url: "https://one.example.net/login", matchingHashes: ["a".repeat(64)] },
					{ domain: "two.example.org", url: "https://two.example.org/", matchingHashes: ["a".repeat(64)] },
				],
				errors: [],
			}),
		});
		expect(result.candidates).toHaveLength(2);
		const analysisJobs = await (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "analyze_kit_sibling")).all();
		expect(analysisJobs).toHaveLength(2);
		expect(analysisJobs.map(({ payload }) => payload)).toEqual([
			{ url: "https://one.example.net/login" },
			{ url: "https://two.example.org/" },
		]);
		expect(analysisJobs[1]!.nextAttemptAt.getTime() - analysisJobs[0]!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(29_000);

		const created: Array<{ url: string; source?: string; reporterCountry?: string }> = [];
		await analyzeKitSibling({ reportId: report.reportId, url: analysisJobs[0]!.payload?.url }, {
			createSubmission: async (options) => {
				created.push(options);
				return 1n;
			},
		});
		expect(created).toMatchObject([
			{ url: "https://one.example.net/login", source: `kit-sibling:${submissionId.toString()}:${report.reportId.toString()}`, reporterCountry: "DE" },
		]);
	});
});
