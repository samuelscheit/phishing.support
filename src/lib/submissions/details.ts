import { AnalysisRunsEntity, ArtifactsEntity, SubmissionsEntity } from "@/lib/db/entities";
import type { AnalysisRun, Artifact, Submission } from "@/lib/db/schema";
import { getReportForSubmission, type SubmissionReport } from "./abuse_details";

export type { SubmissionReport, SubmissionReportArtifact, SubmissionReportMessage, SubmissionReportRoute } from "./abuse_details";

export type SubmissionArtifact = Omit<Artifact, "blob" | "submissionId">;

export type SubmissionDetail = Submission & {
	analysisRuns: AnalysisRun[];
	/** The report filed for a confirmed submission, with every provider route and reply. */
	report: SubmissionReport | null;
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

	const [analysisRuns, report, artifacts] = await Promise.all([
		AnalysisRunsEntity.listForSubmission(submissionId),
		getReportForSubmission(submissionId),
		ArtifactsEntity.listForSubmission(submissionId),
	]);
	return { ...submission, analysisRuns, report, artifacts };
}
