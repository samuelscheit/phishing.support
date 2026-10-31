import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { SubmissionsEntity } from "../../db/entities";
import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import type { WebsiteSiteAssessment } from "../../website_types";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { abuseJobs } from "../schema";
import { analyzeKitSibling, discoverKitSiblings, enqueueKitSiblingDiscovery, isKitSiblingSeed } from "./kit_job";

const CREDENTIAL_KIT: WebsiteSiteAssessment[] = [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign in" }];

async function websiteCase(id: bigint, domain: string, options: { source?: string; siteAssessments?: WebsiteSiteAssessment[] } = {}) {
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: `https://${domain}/`, ...(options.siteAssessments ? { siteAssessments: options.siteAssessments } : {}) } },
		dedupeKey: `website-${domain}`,
		status: "reported",
		source: options.source ?? `https://${domain}/`,
	});
	const request = await validateAbuseReportRequest({
		targets: [domain],
		allegationCategory: "phishing",
		description: "Confirmed credential phishing.",
		observedUrls: [{ target: domain, urls: [`https://${domain}/`] }],
	});
	return AbuseRepository.createReport({ request, reporter: { reporterCountry: "DE" }, submissionId: id });
}

const discoveryJobs = async () => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "discover_kit_siblings")).all();

describe("kit sibling discovery jobs", () => {
	useTemporaryDatabase();

	test("only an original, classifier-confirmed credential or payment kit seeds a search", async () => {
		const cases = {
			credential: await websiteCase(420000000000000001n, "login.example.com", { siteAssessments: CREDENTIAL_KIT }),
			payment: await websiteCase(420000000000000002n, "pay.example.com", { siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "payment_fraud" }] }),
			malware: await websiteCase(420000000000000003n, "update.example.com", { siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "malware_delivery" }] }),
			// A report migrated from the old pipeline never had a classifier verdict (the gambling site that spread to 80 casinos).
			migrated: await websiteCase(420000000000000004n, "casino.example.com"),
			sibling: await websiteCase(420000000000000005n, "sibling.example.com", { source: "kit-sibling:420000000000000001:1", siteAssessments: CREDENTIAL_KIT }),
			originSibling: await websiteCase(420000000000000006n, "origin.example.com", { source: "origin-sibling:420000000000000001:1", siteAssessments: CREDENTIAL_KIT }),
			// A sibling that redirected keeps its lineage through the redirect hand-off.
			redirectedSibling: await websiteCase(420000000000000007n, "landing.example.com", { source: "redirect:420000000000000005", siteAssessments: CREDENTIAL_KIT }),
			redirectedOriginal: await websiteCase(420000000000000008n, "final.example.com", { source: "redirect:420000000000000001", siteAssessments: CREDENTIAL_KIT }),
		};
		const seeds = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([name, report]) => {
			const reportRow = (await AbuseRepository.getReport(report.reportId))!;
			return [name, await isKitSiblingSeed(reportRow.submissionId!)];
		})));
		expect(seeds).toEqual({
			credential: true,
			payment: true,
			malware: false,
			migrated: false,
			sibling: false,
			originSibling: false,
			redirectedSibling: false,
			redirectedOriginal: true,
		});

		for (const report of Object.values(cases)) {
			const reportRow = (await AbuseRepository.getReport(report.reportId))!;
			await enqueueKitSiblingDiscovery(report.reportId, reportRow.submissionId!);
			await enqueueKitSiblingDiscovery(report.reportId, reportRow.submissionId!);
		}
		expect((await discoveryJobs()).map(({ reportId }) => reportId).sort()).toEqual(
			[cases.credential.reportId, cases.payment.reportId, cases.redirectedOriginal.reportId].sort(),
		);

		// A job queued before this rule existed is a no-op when it runs.
		const searched: bigint[] = [];
		const result = await discoverKitSiblings({ reportId: cases.migrated.reportId }, {
			findCandidates: async ({ submissionId }) => {
				searched.push(submissionId);
				return { fingerprints: [], candidates: [], errors: [] };
			},
		});
		expect(result).toEqual({ fingerprints: [], candidates: [], errors: [] });
		expect(searched).toEqual([]);
	});

	test("queues paced analyses and runs each one to completion inside its job", async () => {
		const report = await websiteCase(420000000000000011n, "kit.example.com", { siteAssessments: CREDENTIAL_KIT });
		await discoverKitSiblings({ reportId: report.reportId }, {
			findCandidates: async () => ({
				fingerprints: [{ sha256: "a".repeat(64), mimeType: "application/javascript", url: "https://kit.example.com/index.js", size: 50_000 }],
				candidates: [
					{ domain: "one.example.net", url: "https://one.example.net/login", matchingHashes: ["a".repeat(64)] },
					{ domain: "two.example.org", url: "https://two.example.org/", matchingHashes: ["a".repeat(64)] },
				],
				errors: [],
			}),
		});
		const analysisJobs = await (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "analyze_kit_sibling")).all();
		expect(analysisJobs.map(({ payload }) => payload)).toEqual([
			{ url: "https://one.example.net/login" },
			{ url: "https://two.example.org/" },
		]);
		expect(analysisJobs[1]!.nextAttemptAt.getTime() - analysisJobs[0]!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(29_000);
		expect((await AbuseRepository.listEvents(report.reportId)).filter(({ eventType }) => eventType === "kit_siblings.discovered").map(({ data }) => data)).toEqual([{
			fingerprints: [{ sha256: "a".repeat(64), url: "https://kit.example.com/index.js", size: 50_000 }],
			candidates: ["one.example.net", "two.example.org"],
			errors: [],
		}]);

		let finished = false;
		const started: Array<{ url: string; submissionId: bigint }> = [];
		const submissionId = await analyzeKitSibling({ reportId: report.reportId, url: analysisJobs[0]!.payload?.url }, {
			analyzeWebsite: async (options) => {
				started.push({ url: options.url, submissionId: options.submissionId });
				await Bun.sleep(20);
				finished = true;
				return options.submissionId;
			},
		});
		// The job does not return until the analysis it started has finished.
		expect(finished).toBe(true);
		expect(started).toEqual([{ url: "https://one.example.net/login", submissionId: submissionId! }]);
		const created = (await SubmissionsEntity.get(submissionId!))!;
		expect(created.source).toBe(`kit-sibling:420000000000000011:${report.reportId.toString()}`);
		expect(created.reporterCountry).toBe("DE");
		expect(await isKitSiblingSeed(submissionId!)).toBe(false);
	});

	test("records why a search found nothing", async () => {
		const report = await websiteCase(420000000000000021n, "loader.example.com", { siteAssessments: CREDENTIAL_KIT });
		await discoverKitSiblings({ reportId: report.reportId }, {
			findCandidates: async () => ({ fingerprints: [], candidates: [], errors: ["The capture recorded no scripts or stylesheets."] }),
		});
		const events = (await AbuseRepository.listEvents(report.reportId)).filter(({ eventType }) => eventType === "kit_siblings.discovered");
		expect(events.map(({ data }) => data)).toEqual([{ fingerprints: [], candidates: [], errors: ["The capture recorded no scripts or stylesheets."] }]);
	});

	test("a confirmed sibling never searches again, so discovery stays one level deep", async () => {
		const report = await websiteCase(420000000000000031n, "seed.example.com", { siteAssessments: CREDENTIAL_KIT });
		const sibling = await websiteCase(420000000000000032n, "front-page.example.net", {
			source: `kit-sibling:420000000000000031:${report.reportId.toString()}`,
			siteAssessments: CREDENTIAL_KIT,
		});
		const siblingRow = (await AbuseRepository.getReport(sibling.reportId))!;
		await enqueueKitSiblingDiscovery(sibling.reportId, siblingRow.submissionId!);
		const searched: bigint[] = [];
		await discoverKitSiblings({ reportId: sibling.reportId }, {
			findCandidates: async ({ submissionId }) => {
				searched.push(submissionId);
				return { fingerprints: [], candidates: [], errors: [] };
			},
		});
		expect(await discoveryJobs()).toEqual([]);
		expect(searched).toEqual([]);
	});
});
