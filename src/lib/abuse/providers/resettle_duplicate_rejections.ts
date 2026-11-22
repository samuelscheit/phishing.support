import { AbuseRepository } from "../repository";
import { queueCorrespondencePoll, nextCorrespondencePollDelayMs } from "../worker/schedule";
import { cloudflareProvider } from "./cloudflare";
import { cloudflareApiConfig, cloudflareDuplicateOfRejection } from "./cloudflare/api";
import { storedCloudflareSubmissionPayload } from "./cloudflare/submission";
import { duplicateReceipt } from "./duplicate_reports";
import { netcraftProvider } from "./netcraft";
import { storedNetcraftSubmissionPayload } from "./netcraft/payload";
import { netcraftDuplicateOfRejection } from "./netcraft/submission";
import type { ProviderSubmissionDuplicateError, ProviderSubmissionProvider } from "./submission_contracts";

type Recogniser = {
	provider: ProviderSubmissionProvider;
	duplicateOf(failureReason: string, payload: Record<string, unknown>): ProviderSubmissionDuplicateError | undefined;
};

export type ResettledDuplicate = { routeId: bigint; providerRegistryKey: string; confirmationId?: string };

/**
 * One-off repair: routes whose provider answered "duplicate" were settled
 * `provider_rejected` before duplicates were recognised, though the URL was
 * reported. Each such route whose latest run failed with exactly that answer
 * settles as submitted, with the receipt a live duplicate gets now (an
 * earlier run's report id when one of ours reported the URL), and its
 * correspondence is read when it has a receipt. Any other route, and a
 * second run, change nothing.
 */
export async function resettleDuplicateRejections(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ResettledDuplicate[]> {
	const recognisers: Record<string, Recogniser> = {
		[cloudflareProvider.definition.key]: {
			provider: cloudflareProvider,
			duplicateOf: (reason, payload) => {
				const stored = storedCloudflareSubmissionPayload(payload);
				return stored && cloudflareDuplicateOfRejection(reason, { accountId: cloudflareApiConfig(environment).accountId, target: stored.target });
			},
		},
		[netcraftProvider.definition.key]: {
			provider: netcraftProvider,
			duplicateOf: (reason, payload) => {
				const stored = storedNetcraftSubmissionPayload(payload);
				return stored && netcraftDuplicateOfRejection(reason, stored);
			},
		},
	};
	const resettled: ResettledDuplicate[] = [];
	for (const { routeId, reportId, providerRegistryKey, run } of await AbuseRepository.listRejectedProviderRuns(Object.keys(recognisers))) {
		const { provider, duplicateOf } = recognisers[providerRegistryKey]!;
		const duplicate = run.failureReason ? duplicateOf(run.failureReason, run.providerPayload) : undefined;
		if (!duplicate) continue;
		const success = await duplicateReceipt(provider, duplicate, run.id);
		const settled = await AbuseRepository.resettleRejectedProviderRun({ runId: run.id, providerRegistryKey, reason: "provider_duplicate_answer", success });
		if (!settled) continue;
		if (provider.fetchCorrespondence && success.confirmationId) await queueCorrespondencePoll({ id: routeId, reportId }, { delayMs: nextCorrespondencePollDelayMs(0) });
		resettled.push({ routeId, providerRegistryKey, ...(success.confirmationId ? { confirmationId: success.confirmationId } : {}) });
	}
	return resettled;
}
