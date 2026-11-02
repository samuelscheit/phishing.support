import { fetchSkyvernArtifact } from "../../abuse/skyvern/storage";
import { lookupMalwareBazaar } from "./malwarebazaar";
import type { CollectedDownload } from "./collect";
import { buildSampleArchive } from "./archive_adapter";
import { investigateDownload, type InvestigationOutcome } from "./investigate";
import type { LookupResult, VerdictProvider } from "./policy";
import { sampleRetentionMs } from "./retention";

/**
 * Production wiring for one collected download. Configuration is read from the
 * environment here and nowhere else. Missing secrets and an unset store root
 * fail closed: the file is recorded as skipped, never uploaded or written.
 */
export type DownloadPipelineConfig = {
	storeRoot: string | undefined;
	malwareBazaarAuthKey: string | undefined;
	/** Providers the operator explicitly permits to receive a public upload. */
	uploadPermitted: ReadonlySet<VerdictProvider>;
	retentionMs: number;
};

export function downloadPipelineConfigFromEnvironment(environment: Readonly<Record<string, string | undefined>> = process.env): DownloadPipelineConfig {
	const storeRoot = environment.EXFILTRATION_SAMPLE_STORE_DIR?.trim() || undefined;
	if (storeRoot !== undefined && !storeRoot.startsWith("/")) throw new Error("EXFILTRATION_SAMPLE_STORE_DIR must be an absolute path.");
	const uploadPermitted = new Set<VerdictProvider>();
	// Upload is opt-in per provider. No provider is enabled by default, and ANY.RUN is not a provider.
	for (const provider of (environment.EXFILTRATION_PUBLIC_UPLOAD_PROVIDERS ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
		if (provider !== "malwarebazaar" && provider !== "virustotal" && provider !== "triage") {
			throw new Error("EXFILTRATION_PUBLIC_UPLOAD_PROVIDERS names an unknown provider.");
		}
		uploadPermitted.add(provider);
	}
	return {
		storeRoot,
		malwareBazaarAuthKey: environment.MALWAREBAZAAR_AUTH_KEY?.trim() || undefined,
		uploadPermitted,
		retentionMs: sampleRetentionMs(environment.SAMPLE_RETENTION_DAYS),
	};
}

/**
 * Fetch one download through the audited artifact fetcher (public host on every
 * hop, size cap, redirect cap), then investigate it. The probe calls this only
 * after its capture is durable, and it never executes the file.
 */
export async function investigateCollectedDownload(
	file: CollectedDownload,
	config: DownloadPipelineConfig,
	dependencies: {
		fetch?: (url: string) => Promise<{ body: Buffer; mimeType?: string }>;
		lookups?: (sha256: string) => Promise<LookupResult[]>;
		now?: () => Date;
		phishingBasis: "credential_theft" | "payment_fraud" | "malware_delivery";
	},
): Promise<InvestigationOutcome | undefined> {
	const fetched = await (dependencies.fetch ?? fetchSkyvernArtifact)(file.url.toString());
	const lookups = dependencies.lookups ?? (async (sha256: string): Promise<LookupResult[]> => [
		await lookupMalwareBazaar({ sha256, authKey: config.malwareBazaarAuthKey }),
	]);
	return investigateDownload(
		// No local Authenticode verifier exists yet, so the signature is "unknown" and the
		// policy refuses every public upload. The gate stays in place for when one is built.
		{ bytes: fetched.body, remoteName: file.remoteName, phishingBasis: dependencies.phishingBasis, signature: "unknown" },
		{
			storeRoot: config.storeRoot,
			now: dependencies.now ?? (() => new Date()),
			lookups,
			uploadPermitted: config.uploadPermitted,
			buildArchive: buildSampleArchive,
		},
	);
}
