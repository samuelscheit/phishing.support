/**
 * Decides what to do with a captured download once its local hash is known.
 * This is a pure function of the lookup results, the signature state, and the
 * configuration: it performs no network I/O, so the ordering and fail-closed
 * rules are testable directly.
 */

export type VerdictProvider = "virustotal" | "malwarebazaar" | "triage";

/** What one provider said about a hash. `unavailable` covers every non-answer. */
export type LookupResult =
	| { provider: VerdictProvider; state: "known"; verdict: "malicious" | "suspicious" | "benign" }
	| { provider: VerdictProvider; state: "not_found" }
	| { provider: VerdictProvider; state: "unavailable"; reason: string }
	| { provider: VerdictProvider; state: "not_configured" };

/**
 * The publisher-signature state of a file, decided by a local check and never by
 * the remote side. Only an unsigned file, or one signed by an unexpected signer,
 * may be publicly uploaded. `unknown` means no verifier has decided: it fails closed.
 */
export type SignatureState = "unsigned" | "unexpected_signer" | "trusted_signer" | "unknown";

export type DownloadPolicyInput = {
	phishingBasis: "credential_theft" | "payment_fraud" | "malware_delivery";
	lookups: LookupResult[];
	/** Providers whose operator explicitly enabled public upload. */
	uploadPermitted: ReadonlySet<VerdictProvider>;
	/** Required: an omitted signature state is treated as unverified. */
	signature?: SignatureState;
};

export type DownloadAction =
	| { action: "record_known_verdict"; verdict: "malicious" | "suspicious" | "benign"; provider: VerdictProvider }
	| { action: "upload"; providers: VerdictProvider[] }
	| { action: "skip"; reason: "not_malware_basis" | "lookup_unavailable" | "no_upload_permitted" | "no_provider_configured" | "trusted_signer" | "signature_unverified" };

/**
 * ANY.RUN is not a `VerdictProvider` at all: its API needs an Enterprise plan the
 * operator does not have, so the type makes it impossible to permit it here.
 */
export function decideDownloadAction(input: DownloadPolicyInput): DownloadAction {
	// A known verdict short-circuits everything: never upload what is already classified.
	for (const lookup of input.lookups) {
		if (lookup.state === "known") {
			return { action: "record_known_verdict", verdict: lookup.verdict, provider: lookup.provider };
		}
	}
	// Only a malware-delivery classification justifies a public upload at all.
	if (input.phishingBasis !== "malware_delivery") return { action: "skip", reason: "not_malware_basis" };
	// Any provider that could not answer means "unknown", and unknown never triggers an upload.
	if (input.lookups.some((lookup) => lookup.state === "unavailable")) return { action: "skip", reason: "lookup_unavailable" };
	const configured = input.lookups.filter((lookup) => lookup.state !== "not_configured");
	if (configured.length === 0) return { action: "skip", reason: "no_provider_configured" };
	// Every configured provider must have explicitly reported "not found" before an upload.
	if (configured.some((lookup) => lookup.state !== "not_found")) return { action: "skip", reason: "lookup_unavailable" };
	// Every provider permitted to receive an upload must itself have been asked for a verdict.
	const queried = new Set(configured.map((lookup) => lookup.provider));
	const providers = [...input.uploadPermitted].sort();
	if (providers.length === 0) return { action: "skip", reason: "no_upload_permitted" };
	if (providers.some((provider) => !queried.has(provider))) return { action: "skip", reason: "lookup_unavailable" };
	// The publisher signature decides whether a public upload is appropriate at all.
	if (input.signature === "trusted_signer") return { action: "skip", reason: "trusted_signer" };
	if (input.signature !== "unsigned" && input.signature !== "unexpected_signer") return { action: "skip", reason: "signature_unverified" };
	return { action: "upload", providers };
}
