import { validateAbuseReportRequest } from "../abuse/contracts";
import { websiteReportSubject } from "@/lib/abuse/persistence/reports";
import { AbuseRepository } from "../abuse/repository";
import { SubmissionsEntity } from "../db/entities/submissions";
import type { SubmissionStatus, WebsiteSubmissionData } from "../db/schema";
import { websiteSite } from "../website/info/site";
import type { CampaignSite } from "./members";

/**
 * Report one site of a stored case as the analysis does: the case's own
 * primary report of the site, or, when another case's open report covers the
 * site already, that report, which the case joins.
 */
export async function reportCaseSite(submissionId: bigint, url: string): Promise<CampaignSite> {
	const host = new URL(url).hostname;
	const request = await validateAbuseReportRequest({ targets: [host], allegationCategory: "phishing", description: `Confirmed credential phishing on ${url}.`, observedUrls: [{ target: host, urls: [url] }] });
	const created = await AbuseRepository.createReport({ request, reporter: {}, submissionId, subject: websiteReportSubject(url) });
	return { submissionId, reportId: created.reportId, site: websiteSite(url) };
}

/** A stored website case with each confirmed site (by its judged page's URL; the submitted URL's by default) reported: its campaign members. */
export async function confirmedCase(id: bigint, website: WebsiteSubmissionData, options: { sites?: string[]; status?: SubmissionStatus; source?: string } = {}): Promise<CampaignSite[]> {
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website }, dedupeKey: `website-${id.toString()}`, status: options.status ?? "reported", ...(options.source ? { source: options.source } : {}) });
	const members: CampaignSite[] = [];
	for (const url of options.sites ?? [website.url]) members.push(await reportCaseSite(id, url));
	return members;
}
