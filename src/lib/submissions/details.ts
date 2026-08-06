import { AnalysisRunsEntity, ArtifactsEntity, ReportsEntity, SubmissionsEntity } from "@/lib/db/entities";

export async function getSubmissionDetails(id: string) {
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
		ReportsEntity.listForSubmission(submissionId),
		ArtifactsEntity.listForSubmission(submissionId),
	]);

	return {
		...submission,
		analysisRuns,
		reports,
		artifacts,
	};
}
