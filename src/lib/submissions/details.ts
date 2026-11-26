import { CampaignRepository } from "@/lib/campaign/repository";
import { AnalysisRunsEntity } from "@/lib/db/entities/analysis_runs";
import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { SubmissionRetriesEntity } from "@/lib/db/entities/submission_retries";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { AnalysisRun, Artifact, Submission } from "@/lib/db/schema";
import { withoutBackendSecrets } from "@/lib/exfiltration/secrets";
import { publicReporterHeaders } from "@/lib/http/reporter_headers";
import { getReportsForSubmission, type SubmissionReport } from "./abuse_details";

export type { SubmissionReport, SubmissionReportArtifact, SubmissionReportMessage, SubmissionReportRoute } from "./abuse_details";

type SubmissionArtifact = Omit<Artifact, "blob" | "submissionId">;

/** The visitor's IP is never public; their headers are cut to the device ones. */
export type SubmissionDetail = Omit<Submission, "reporterIp"> & {
	analysisRuns: AnalysisRun[];
	/** Primary and discovered-backend reports, each with provider routes and replies. */
	reports: SubmissionReport[];
	artifacts: SubmissionArtifact[];
	/**
	 * The campaigns the case's confirmed sites belong to, once each, with the
	 * host of the case's first site in it: each public page tells a visitor
	 * what to do and lists the group's other sites.
	 */
	campaigns: Array<{ id: string; siteCount: number; host: string }>;
	/** How often the case was analyzed again, by anyone or automatically, and when last. */
	retries: { count: number; lastAt: Date | null };
};

async function campaignsOf(submissionId: bigint): Promise<SubmissionDetail["campaigns"]> {
	const campaigns = new Map<bigint, { id: string; siteCount: number; host: string }>();
	for (const { campaignId, ...member } of await CampaignRepository.listCaseMemberships(submissionId)) {
		if (campaigns.has(campaignId)) continue;
		const site = await CampaignRepository.siteOf(member);
		if (site === undefined) continue;
		campaigns.set(campaignId, { id: campaignId.toString(), siteCount: await CampaignRepository.memberCount(campaignId), host: site.split("/")[0]! });
	}
	return [...campaigns.values()];
}

/**
 * A case as its public page and API show it: data-drop credentials redacted,
 * the reporter's IP dropped and their headers cut to the device ones. The
 * stored case keeps them all.
 */
export async function getSubmissionDetails(id: string): Promise<SubmissionDetail | undefined> {
	let submissionId: bigint;
	try {
		submissionId = BigInt(id);
	} catch {
		return undefined;
	}

	const stored = await SubmissionsEntity.get(submissionId);
	if (!stored) return undefined;
	const { reporterIp: _reporterIp, ...submission } = stored;

	const [analysisRuns, reports, artifacts, campaigns, retries] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		getReportsForSubmission(submissionId),
		ArtifactsEntity.listForSubmission(submissionId),
		campaignsOf(submissionId),
		SubmissionRetriesEntity.summaryForSubmission(submissionId),
	]);
	return withoutBackendSecrets({
		...submission,
		reporterHeaders: publicReporterHeaders(submission.reporterHeaders),
		analysisRuns,
		reports,
		artifacts,
		campaigns,
		retries,
	});
}
