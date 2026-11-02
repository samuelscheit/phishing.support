import { fetchSkyvernArtifact } from "../../abuse/skyvern/storage";
import { lookupMalwareBazaar } from "./malwarebazaar";
import { lookupVirusTotal } from "./virustotal";
import { uploadToVirusTotal } from "./virustotal_upload";
import { signatureStateOf } from "./pe_signature";
import type { CollectedDownload } from "./collect";
import { buildSampleArchive } from "./archive_adapter";
import { investigateDownload, type InvestigationOutcome, type SubmitFile } from "./investigate";
import type { LookupResult, SignatureState, VerdictProvider } from "./policy";
import { sampleRetentionMs } from "./retention";

/**
 * Production wiring for one collected download. Configuration is read from the
 * environment here and nowhere else. Missing secrets and an unset store root
 * fail closed: the file is recorded as skipped, never uploaded or written.
 */
export type DownloadPipelineConfig = {
	storeRoot: string | undefined;
	malwareBazaarAuthKey: string | undefined;
	virusTotalApiKey: string | undefined;
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
		virusTotalApiKey: environment.VIRUSTOTAL_API_KEY?.trim() || undefined,
		uploadPermitted,
		retentionMs: sampleRetentionMs(environment.SAMPLE_RETENTION_DAYS),
	};
}

/**
 * Fetch one download through the audited artifact fetcher (public host on every
 * hop, size cap, redirect cap), then investigate it. The probe calls this only
 * after its capture is durable, and it never executes the file. Every provider
 * is queried by hash, and an upload goes only to a provider the operator permitted.
 */
export async function investigateCollectedDownload(
	file: CollectedDownload,
	config: DownloadPipelineConfig,
	dependencies: {
		fetch?: (url: string) => Promise<{ body: Buffer; mimeType?: string }>;
		lookups?: (sha256: string) => Promise<LookupResult[]>;
		submit?: SubmitFile;
		now?: () => Date;
		phishingBasis: "credential_theft" | "payment_fraud" | "malware_delivery";
	},
): Promise<InvestigationOutcome | undefined> {
	const fetched = await (dependencies.fetch ?? fetchSkyvernArtifact)(file.url.toString());
	// The structural check reads the certificate table only; the file is never loaded or executed.
	const signature: SignatureState = signatureStateOf(fetched.body);
	const lookups = dependencies.lookups ?? (async (sha256: string): Promise<LookupResult[]> => [
		await lookupMalwareBazaar({ sha256, authKey: config.malwareBazaarAuthKey }),
		await lookupVirusTotal({ sha256, apiKey: config.virusTotalApiKey }),
	]);
	const submit = dependencies.submit ?? (async (provider: VerdictProvider, upload: { bytes: Buffer; fileName: string }) => {
		if (provider !== "virustotal") return { state: "not_attempted" as const, reason: "no upload transport for this provider" };
		return uploadToVirusTotal({ bytes: upload.bytes, apiKey: config.virusTotalApiKey, fileName: upload.fileName });
	});
	return investigateDownload(
		{ bytes: fetched.body, remoteName: file.remoteName, phishingBasis: dependencies.phishingBasis, origin: "probe", signature },
		{
			storeRoot: config.storeRoot,
			now: dependencies.now ?? (() => new Date()),
			lookups,
			uploadPermitted: config.uploadPermitted,
			buildArchive: buildSampleArchive,
			submit,
		},
	);
}
