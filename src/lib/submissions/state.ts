import { SubmissionsEntity } from "../db/entities/submissions";

export async function markSubmissionInvalid(submissionId: bigint): Promise<void> {
	await SubmissionsEntity.update(submissionId, { status: "invalid" });
}
