import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../../db/entities";
import { useTemporaryDatabase } from "../../db/test_helpers";
import type { WebsiteSiteAssessment } from "../../website_types";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { analyzeKitSibling, isKitSiblingSeed } from "./kit_job";

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

describe("kit sibling jobs", () => {
	useTemporaryDatabase();

	test("only an original, classifier-confirmed phishing or malware kit seeds a search", async () => {
		const cases = {
			credential: await websiteCase(420000000000000001n, "login.example.com", { siteAssessments: CREDENTIAL_KIT }),
			payment: await websiteCase(420000000000000002n, "pay.example.com", { siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "payment_fraud" }] }),
			// A malware kit, such as an exploit loader on many lure domains (production case 377486973465530391).
			malware: await websiteCase(420000000000000003n, "update.example.com", { siteAssessments: [{ hopIndex: 0, finding: "malware" }] }),
			unconfirmed: await websiteCase(420000000000000009n, "maybe.example.com", { siteAssessments: [{ hopIndex: 0, finding: "insufficient_evidence" }] }),
			malwareSibling: await websiteCase(420000000000000010n, "lure.example.com", { source: "kit-sibling:420000000000000003:1", siteAssessments: [{ hopIndex: 0, finding: "malware" }] }),
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
			malware: true,
			unconfirmed: false,
			malwareSibling: false,
			migrated: false,
			sibling: false,
			originSibling: false,
			redirectedSibling: false,
			redirectedOriginal: true,
		});
	});

	test("runs a sibling's analysis to completion inside its job, as a case that never seeds a search", async () => {
		const report = await websiteCase(420000000000000011n, "kit.example.com", { siteAssessments: CREDENTIAL_KIT });
		let finished = false;
		const started: Array<{ url: string; submissionId: bigint }> = [];
		const submissionId = await analyzeKitSibling({ reportId: report.reportId, url: "https://one.example.net/login" }, {
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
});
