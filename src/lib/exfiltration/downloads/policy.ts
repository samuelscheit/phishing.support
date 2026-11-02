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
 * The signature state of a file, decided by a local structural check and never by
 * the remote side. Only a file with no certificate table (`not_signed`) may be
 * publicly uploaded. A certificate table (`signed_binary`) is a legitimate installer
 * and is never uploaded on a structural signal alone. `unknown` fails closed.
 */
export type SignatureState = "not_signed" | "signed_binary" | "unknown";

/**
 * Every file decided here was captured by us from a site already confirmed as
 * phishing or malware: a download the form probe clicked, or the payload a
 * pasted command fetches. Such a file may be uploaded once every provider
 * reports it unknown.
 */
export type DownloadPolicyInput = {
	lookups: LookupResult[];
	/** Providers whose operator explicitly enabled public upload. */
	uploadPermitted: ReadonlySet<VerdictProvider>;
	/** Required: an omitted signature state fails closed. */
	signature?: SignatureState;
};

export type DownloadAction =
	| { action: "record_known_verdict"; verdict: "malicious" | "suspicious" | "benign"; provider: VerdictProvider }
	| { action: "upload"; providers: VerdictProvider[] }
	| { action: "skip"; reason: "lookup_unavailable" | "no_upload_permitted" | "no_provider_configured" | "signed_binary" | "signature_unverified" };

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
	// A signed installer is a legitimate binary; it is never sent to a public service on
	// a structural signal alone. An undecided state fails closed.
	if (input.signature === "signed_binary") return { action: "skip", reason: "signed_binary" };
	if (input.signature !== "not_signed") return { action: "skip", reason: "signature_unverified" };
	return { action: "upload", providers };
}
