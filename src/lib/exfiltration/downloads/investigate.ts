import { createHash } from "node:crypto";

import { decideDownloadAction, type DownloadAction, type LookupResult, type SignatureState, type VerdictProvider } from "./policy";
import { type StoredSample, storeSample } from "./sample_store";

/**
 * Investigate one captured download. The order is fixed and every step can only
 * move toward "no action": hash locally, look up verdicts, decide, and only then
 * keep the sample. The file is never executed, opened, or parsed here.
 */
export type DownloadEvidence = {
	bytes: Buffer;
	/** Untrusted remote name; used only as sanitized metadata. */
	remoteName: string | undefined;
	phishingBasis: "credential_theft" | "payment_fraud" | "malware_delivery";
	/** Required: the publisher-signature state from a local check. Nothing is uploaded without it. */
	signature: SignatureState;
};

export type InvestigationDependencies = {
	storeRoot: string | undefined;
	now(): Date;
	lookups(sha256: string): Promise<LookupResult[]>;
	uploadPermitted: ReadonlySet<VerdictProvider>;
	buildArchive(entryName: string, data: Buffer, password: string): Buffer;
};

export type InvestigationOutcome = {
	sha256: string;
	action: DownloadAction;
	/** Present only when the sample was kept in its protected archive. */
	stored?: StoredSample;
};

export async function investigateDownload(evidence: DownloadEvidence, deps: InvestigationDependencies): Promise<InvestigationOutcome> {
	if (evidence.bytes.byteLength === 0) throw new Error("An empty download is not investigated.");
	// Step 1: the hash is computed locally, before any provider is contacted.
	const sha256 = createHash("sha256").update(evidence.bytes).digest("hex");
	// Step 2: verdict lookups happen before any decision that could upload.
	const lookups = await deps.lookups(sha256);
	// Step 3: the decision is pure; no upload is possible unless it returns "upload".
	const action = decideDownloadAction({ phishingBasis: evidence.phishingBasis, lookups, uploadPermitted: deps.uploadPermitted, signature: evidence.signature });
	// Step 4: keep the sample only when a store is configured. Without one, the hash and
	// verdicts are still recorded, so the investigation never fails for missing storage.
	if (!deps.storeRoot) return { sha256, action };
	const stored = await storeSample({ root: deps.storeRoot, bytes: evidence.bytes, remoteName: evidence.remoteName, now: deps.now(), buildArchive: deps.buildArchive });
	return { sha256, action, stored };
}
