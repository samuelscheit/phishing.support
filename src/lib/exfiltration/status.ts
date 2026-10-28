import { SubmissionsEntity } from "../db/entities";
import type { WebsiteSubmissionData } from "../db/schema";

export async function setExfiltrationProbeStatus(
	submissionId: bigint,
	probe: WebsiteSubmissionData["backendProbe"],
): Promise<void> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website") return;
	await SubmissionsEntity.update(submissionId, {
		data: {
			kind: "website",
			website: { ...submission.data.website, backendProbe: probe },
		},
	});
}
