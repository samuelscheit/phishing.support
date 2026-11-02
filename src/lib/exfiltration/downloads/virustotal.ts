import type { LookupResult } from "./policy";

/** Official VirusTotal v3 API base. Every call sends the key in the `x-apikey` header. */
const VIRUSTOTAL_API = "https://www.virustotal.com/api/v3";
const LOOKUP_TIMEOUT_MS = 15_000;
const SHA256 = /^[a-f0-9]{64}$/;

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Hash lookup against the VirusTotal file report. Only a 200 with a verdict, or
 * the documented 404 NotFoundError, changes what the policy may do. A quota,
 * credential, server, or transport failure is `unavailable`, never "no verdict":
 * an outage must not be read as permission to upload.
 */
export async function lookupVirusTotal(params: {
	sha256: string;
	apiKey: string | undefined;
	fetch?: Fetch;
	signal?: AbortSignal;
}): Promise<LookupResult> {
	const provider = "virustotal" as const;
	if (!params.apiKey?.trim()) return { provider, state: "not_configured" };
	if (!SHA256.test(params.sha256)) return { provider, state: "unavailable", reason: "invalid SHA-256" };
	let response: Response;
	try {
		response = await (params.fetch ?? fetch)(`${VIRUSTOTAL_API}/files/${params.sha256}`, {
			method: "GET",
			headers: { "x-apikey": params.apiKey.trim(), accept: "application/json" },
			signal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]) : AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
	} catch {
		return { provider, state: "unavailable", reason: "transport failure" };
	}
	if (response.status === 404) {
		const body = await response.json().catch(() => undefined) as { error?: { code?: unknown } } | undefined;
		if (body?.error?.code === "NotFoundError") return { provider, state: "not_found" };
		return { provider, state: "unavailable", reason: "unexpected 404" };
	}
	if (!response.ok) return { provider, state: "unavailable", reason: `HTTP ${response.status}` };
	const body = await response.json().catch(() => undefined) as {
		data?: { id?: unknown; attributes?: { sha256?: unknown; last_analysis_stats?: { malicious?: unknown; suspicious?: unknown; harmless?: unknown; undetected?: unknown } } };
	} | undefined;
	const attributes = body?.data?.attributes;
	const stats = attributes?.last_analysis_stats;
	// A file report must echo the queried hash; otherwise it cannot be this file's verdict.
	if (typeof attributes?.sha256 !== "string" || attributes.sha256.toLowerCase() !== params.sha256) {
		return { provider, state: "unavailable", reason: "report does not match the queried hash" };
	}
	if (!stats || typeof stats.malicious !== "number" || typeof stats.suspicious !== "number") {
		return { provider, state: "unavailable", reason: "report has no analysis statistics" };
	}
	if (stats.malicious > 0) return { provider, state: "known", verdict: "malicious" };
	if (stats.suspicious > 0) return { provider, state: "known", verdict: "suspicious" };
	return { provider, state: "known", verdict: "benign" };
}
