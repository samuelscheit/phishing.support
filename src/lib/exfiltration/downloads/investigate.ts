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
	/** Where the file came from; probe files may be uploaded once every provider reports them unknown. */
	origin: "probe" | "other";
	/** Required: the structural signature state. Nothing is uploaded without it. */
	signature: SignatureState;
};

/** A submission made for one provider, with the provider's answer. */
export type UploadOutcome =
	| { provider: VerdictProvider; state: "submitted"; analysisId: string }
	| { provider: VerdictProvider; state: "not_attempted"; reason: string }
	| { provider: VerdictProvider; state: "failed"; reason: string };

/** Sends one file to one provider. The file name is a safe leaf name chosen here, never the remote name. */
export type SubmitFile = (provider: VerdictProvider, file: { bytes: Buffer; fileName: string }) => Promise<
	| { state: "submitted"; analysisId: string }
	| { state: "not_attempted"; reason: string }
	| { state: "failed"; reason: string }
>;

export type InvestigationDependencies = {
	storeRoot: string | undefined;
	now(): Date;
	lookups(sha256: string): Promise<LookupResult[]>;
	uploadPermitted: ReadonlySet<VerdictProvider>;
	buildArchive(entryName: string, data: Buffer, password: string): Promise<Buffer>;
	/** Performs an upload the policy has decided on. Absent means no upload transport is configured. */
	submit?: SubmitFile;
};

export type InvestigationOutcome = {
	sha256: string;
	action: DownloadAction;
	/** One entry per provider the policy decided to upload to; empty when nothing was uploaded. */
	uploads: UploadOutcome[];
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
	const action = decideDownloadAction({ phishingBasis: evidence.phishingBasis, origin: evidence.origin, lookups, uploadPermitted: deps.uploadPermitted, signature: evidence.signature });
	// Step 3b: only a decided upload reaches the transport, and each provider gets the same safe leaf name.
	const uploads: UploadOutcome[] = [];
	if (action.action === "upload") {
		const fileName = `${sha256.slice(0, 16)}.bin`;
		for (const provider of action.providers) {
			// A decided upload with no transport is recorded, never dropped silently.
			if (!deps.submit) {
				uploads.push({ provider, state: "not_attempted", reason: "no upload transport configured" });
				continue;
			}
			const result = await deps.submit(provider, { bytes: evidence.bytes, fileName });
			uploads.push({ provider, ...result });
		}
	}
	// Step 4: keep the sample only when a store is configured. Without one, the hash and
	// verdicts are still recorded, so the investigation never fails for missing storage.
	if (!deps.storeRoot) return { sha256, action, uploads };
	const stored = await storeSample({ root: deps.storeRoot, bytes: evidence.bytes, remoteName: evidence.remoteName, now: deps.now(), buildArchive: deps.buildArchive });
	return { sha256, action, uploads, stored };
}
