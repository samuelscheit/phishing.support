import { SubmissionsEntity } from "../db/entities";

export async function markSubmissionInvalid(submissionId: bigint): Promise<void> {
	await SubmissionsEntity.update(submissionId, { status: "invalid" });
}
