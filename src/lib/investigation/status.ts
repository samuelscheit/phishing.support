import { SubmissionsEntity } from "../db/entities";
import type { WebsiteSubmissionData } from "../db/schema";

/** Record where a website case's pre-report investigation stands; it never changes the verdict. */
export async function setInvestigationStatus(
	submissionId: bigint,
	investigation: WebsiteSubmissionData["investigation"],
): Promise<void> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website") return;
	await SubmissionsEntity.update(submissionId, {
		data: {
			kind: "website",
			website: { ...submission.data.website, investigation },
		},
	});
}
