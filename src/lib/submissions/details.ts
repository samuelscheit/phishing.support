import { CampaignRepository } from "@/lib/campaign/repository";
import { AnalysisRunsEntity } from "@/lib/db/entities/analysis_runs";
import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { AnalysisRun, Artifact, Submission } from "@/lib/db/schema";
import { getReportsForSubmission, type SubmissionReport } from "./abuse_details";

export type { SubmissionReport, SubmissionReportArtifact, SubmissionReportMessage, SubmissionReportRoute } from "./abuse_details";

export type SubmissionArtifact = Omit<Artifact, "blob" | "submissionId">;

export type SubmissionDetail = Submission & {
	analysisRuns: AnalysisRun[];
	/** Primary and discovered-backend reports, each with provider routes and replies. */
	reports: SubmissionReport[];
	artifacts: SubmissionArtifact[];
	/** The campaign the site belongs to: its public page tells a visitor what to do and lists the group's other sites. */
	campaign?: { id: string; siteCount: number };
};

async function campaignOf(submissionId: bigint): Promise<SubmissionDetail["campaign"]> {
	const campaignId = await CampaignRepository.campaignForSubmission(submissionId);
	if (campaignId === undefined) return undefined;
	return { id: campaignId.toString(), siteCount: await CampaignRepository.memberCount(campaignId) };
}

export async function getSubmissionDetails(id: string): Promise<SubmissionDetail | undefined> {
	let submissionId: bigint;
	try {
		submissionId = BigInt(id);
	} catch {
		return undefined;
	}

	const submission = await SubmissionsEntity.get(submissionId);
	if (!submission) return undefined;

	const [analysisRuns, reports, artifacts, campaign] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		getReportsForSubmission(submissionId),
		ArtifactsEntity.listForSubmission(submissionId),
		campaignOf(submissionId),
	]);
	return { ...submission, analysisRuns, reports, artifacts, ...(campaign ? { campaign } : {}) };
}
