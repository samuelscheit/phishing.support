import { AbuseRepository } from "../repository";
import { normalizeDomain } from "../security/security";
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

/**
 * The target of a run stored before drafts carried their definition pin
 * (`cloudflare_abuse_api_v1` without `definition`, production 2026-11-19):
 * every rejected duplicate in production has that shape, and the target is
 * all the repair needs from it.
 */
function legacyCloudflareTarget(payload: Record<string, unknown>): string | undefined {
	return payload.adapter === "cloudflare_abuse_api_v1" && payload.definition === undefined && typeof payload.target === "string"
		? normalizeDomain(payload.target)
		: undefined;
}

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
				const target = storedCloudflareSubmissionPayload(payload)?.target ?? legacyCloudflareTarget(payload);
				return target ? cloudflareDuplicateOfRejection(reason, { accountId: cloudflareApiConfig(environment).accountId, target }) : undefined;
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
