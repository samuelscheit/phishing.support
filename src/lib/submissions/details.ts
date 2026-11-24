import { CampaignRepository } from "@/lib/campaign/repository";
import { AnalysisRunsEntity } from "@/lib/db/entities/analysis_runs";
import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { AnalysisRun, Artifact, Submission } from "@/lib/db/schema";
import { withoutBackendSecrets } from "@/lib/exfiltration/secrets";
import { getReportsForSubmission, type SubmissionReport } from "./abuse_details";

export type { SubmissionReport, SubmissionReportArtifact, SubmissionReportMessage, SubmissionReportRoute } from "./abuse_details";

type SubmissionArtifact = Omit<Artifact, "blob" | "submissionId">;

export type SubmissionDetail = Submission & {
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

/** A case as its public page and API show it: data-drop credentials redacted, the stored case keeps them. */
export async function getSubmissionDetails(id: string): Promise<SubmissionDetail | undefined> {
	let submissionId: bigint;
	try {
		submissionId = BigInt(id);
	} catch {
		return undefined;
	}

	const submission = await SubmissionsEntity.get(submissionId);
	if (!submission) return undefined;

	const [analysisRuns, reports, artifacts, campaigns] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		getReportsForSubmission(submissionId),
		ArtifactsEntity.listForSubmission(submissionId),
		campaignsOf(submissionId),
	]);
	return withoutBackendSecrets({ ...submission, analysisRuns, reports, artifacts, campaigns });
}
