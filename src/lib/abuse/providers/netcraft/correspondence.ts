import { fetchNetcraftSubmissionState, type NetcraftFetch } from "../../../netcraft/api";
import type { AbuseMailClassification } from "../../schema";
import type { ProviderCorrespondence } from "../submission_contracts";

/**
 * Netcraft's verdict on a submission (report API v3: `processing`, `no
 * threats`, `suspicious`, `malicious`, `unavailable`). `malicious` and
 * `suspicious` mean it blocks the site and starts its own takedown; `no
 * threats` means it found nothing; the rest is no verdict yet.
 */
export const NETCRAFT_REVIEW_VERDICTS: Readonly<Record<string, AbuseMailClassification>> = {
	malicious: "acknowledged",
	suspicious: "acknowledged",
	"no threats": "rejected",
};

/** Netcraft answers only through the submission's state; it sends no messages of its own here. */
export async function fetchNetcraftCorrespondence(
	context: { confirmationId: string; signal?: AbortSignal },
	dependencies: { fetch?: NetcraftFetch } = {},
): Promise<ProviderCorrespondence> {
	const status = await fetchNetcraftSubmissionState({ uuid: context.confirmationId, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
	return { messages: [], status: { state: status.state.toLowerCase() }, final: !status.pending };
}
