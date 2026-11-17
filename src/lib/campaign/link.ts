import { errorText } from "../error_text";
import { extractIndicators, type IndicatorDependencies } from "./indicators";
import { CampaignRepository } from "./repository";

/**
 * Record what one confirmed site shows about its operator and put it into
 * its campaign. Runs again whenever the case learns more (a backend report
 * after the investigation), and gives the same result for the same evidence.
 */
export async function linkSubmissionToCampaign(submissionId: bigint, dependencies: IndicatorDependencies = {}): Promise<bigint | undefined> {
	const indicators = await extractIndicators(submissionId, dependencies);
	return CampaignRepository.recordIndicators(submissionId, indicators);
}

/**
 * Extract the indicators of every confirmed website again and regroup all
 * campaigns. A site whose extraction fails keeps what is on record.
 */
export async function rebuildCampaigns(dependencies: IndicatorDependencies = {}): Promise<{ linked: number; failed: Array<{ submissionId: string; error: string }> }> {
	const failed: Array<{ submissionId: string; error: string }> = [];
	let linked = 0;
	for (const submissionId of await CampaignRepository.listReportedWebsiteSubmissionIds()) {
		try {
			await linkSubmissionToCampaign(submissionId, dependencies);
			linked += 1;
		} catch (error) {
			failed.push({ submissionId: submissionId.toString(), error: errorText(error) });
		}
	}
	await CampaignRepository.recluster();
	return { linked, failed };
}
