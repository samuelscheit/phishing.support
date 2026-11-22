import { AbuseRepository } from "../repository";
import type { ProviderSubmissionDuplicateError, ProviderSubmissionProvider, ProviderSubmissionSuccess } from "./submission_contracts";

/**
 * What a duplicate answer settles as: the receipt of the newest earlier
 * completed run of the same provider whose payload reported every duplicated
 * URL (so correspondence polling reads that report), else the provider's own
 * receipt for the answer. A failed lookup never turns the answer into a failure.
 */
export async function duplicateReceipt(
	provider: ProviderSubmissionProvider,
	duplicate: ProviderSubmissionDuplicateError,
	runId?: bigint,
): Promise<ProviderSubmissionSuccess> {
	const [first] = duplicate.urls;
	if (!first || !provider.reportedUrls) return duplicate.receipt;
	try {
		const candidates = await AbuseRepository.listReceiptRunsNamingUrl({
			providerRegistryKey: provider.definition.key,
			url: first,
			...(runId === undefined ? {} : { excludeRunId: runId }),
		});
		const earlier = candidates.find((run) => {
			const reported = provider.reportedUrls!(run.providerPayload);
			return duplicate.urls.every((url) => reported.includes(url));
		});
		if (!earlier?.confirmationId) return duplicate.receipt;
		return {
			...duplicate.receipt,
			confirmationId: earlier.confirmationId,
			confirmationText: `${duplicate.receipt.confirmationText} Its earlier report ${earlier.confirmationId} is this route's receipt.`,
			...(earlier.finalUrl ? { finalUrl: earlier.finalUrl } : {}),
		};
	} catch (error) {
		console.warn(`Looking up an earlier ${provider.definition.key} receipt for ${first} failed:`, error);
		return duplicate.receipt;
	}
}
