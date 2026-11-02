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

const ANALYSIS_POLL_MS = 20_000;
const ANALYSIS_WAIT_MS = 4 * 60_000;

/**
 * Wait for the public analysis of a file we just submitted, then read its
 * verdict from the file report. A provider that never finishes leaves the
 * report with the analysis link only; that is not a failure.
 */
export async function awaitVirusTotalVerdict(params: {
	sha256: string;
	analysisId: string;
	apiKey: string | undefined;
	fetch?: Fetch;
	signal?: AbortSignal;
	sleep?: (ms: number) => Promise<void>;
	waitMs?: number;
}): Promise<LookupResult> {
	const provider = "virustotal" as const;
	if (!params.apiKey?.trim()) return { provider, state: "not_configured" };
	const pause = params.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = Date.now() + (params.waitMs ?? ANALYSIS_WAIT_MS);
	while (Date.now() < deadline) {
		params.signal?.throwIfAborted();
		try {
			const response = await (params.fetch ?? fetch)(`${VIRUSTOTAL_API}/analyses/${encodeURIComponent(params.analysisId)}`, {
				headers: { "x-apikey": params.apiKey.trim(), accept: "application/json" },
				signal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]) : AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
			});
			const body = response.ok ? await response.json().catch(() => undefined) as { data?: { attributes?: { status?: unknown } } } | undefined : undefined;
			if (body?.data?.attributes?.status === "completed") {
				return lookupVirusTotal({ sha256: params.sha256, apiKey: params.apiKey, ...(params.fetch ? { fetch: params.fetch } : {}), ...(params.signal ? { signal: params.signal } : {}) });
			}
		} catch (error) {
			if (params.signal?.aborted) throw error;
		}
		await pause(ANALYSIS_POLL_MS);
	}
	return { provider, state: "unavailable", reason: "analysis did not finish in time" };
}
