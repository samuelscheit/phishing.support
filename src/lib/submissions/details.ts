import { AnalysisRunsEntity, ArtifactsEntity, SubmissionsEntity } from "@/lib/db/entities";
import type { AnalysisRun, Artifact, Submission } from "@/lib/db/schema";
import { getReportsForSubmission, type SubmissionReport } from "./abuse_details";

export type { SubmissionReport, SubmissionReportArtifact, SubmissionReportMessage, SubmissionReportRoute } from "./abuse_details";

export type SubmissionArtifact = Omit<Artifact, "blob" | "submissionId">;

export type SubmissionDetail = Submission & {
	analysisRuns: AnalysisRun[];
	/** Primary and discovered-backend reports, each with provider routes and replies. */
	reports: SubmissionReport[];
	artifacts: SubmissionArtifact[];
};

export async function getSubmissionDetails(id: string): Promise<SubmissionDetail | undefined> {
	let submissionId: bigint;
	try {
		submissionId = BigInt(id);
	} catch {
		return undefined;
	}

	const submission = await SubmissionsEntity.get(submissionId);
	if (!submission) return undefined;

	const [analysisRuns, reports, artifacts] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		getReportsForSubmission(submissionId),
		ArtifactsEntity.listForSubmission(submissionId),
	]);
	return { ...submission, analysisRuns, reports, artifacts };
}
