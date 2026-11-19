import { z } from "zod";

import { fetchJson, fetchText, RequestStatusError, RequestTimeoutError, type FetchImplementation } from "../../network/bounded_fetch";

/**
 * urlscan.io, read only: searching its scans, a scan's recorded requests and
 * the page DOM it saw. Our key's search reaches back a few months; a scan
 * older than that is not found.
 */

const URLSCAN_API = "https://urlscan.io";

/**
 * urlscan could not answer now (its quota is used up, it is overloaded, or it
 * timed out): asking later may succeed, so nothing is concluded from it.
 */
export function isUrlscanBusy(error: unknown): error is RequestTimeoutError | RequestStatusError {
	return error instanceof RequestTimeoutError || error instanceof RequestStatusError && (error.status === 429 || error.status >= 500);
}

/** How long to leave urlscan alone after it was busy: what it said, else an hour. */
export function urlscanRetryAfterMs(error: unknown): number {
	return error instanceof RequestStatusError && error.retryAfterMs !== undefined ? error.retryAfterMs : 60 * 60_000;
}

export type UrlscanDependencies = {
	fetch?: FetchImplementation;
	apiKey?: string;
};

const searchResponseSchema = z.object({
	has_more: z.boolean().optional(),
	results: z.array(z.object({
		_id: z.string().optional(),
		page: z.object({ domain: z.string().optional(), url: z.string().optional(), mimeType: z.string().optional() }).passthrough().optional(),
		task: z.object({ domain: z.string().optional(), url: z.string().optional(), time: z.string().optional() }).passthrough().optional(),
	}).passthrough()),
}).passthrough();

export type UrlscanSearchResponse = z.infer<typeof searchResponseSchema>;

const resultSchema = z.object({
	data: z.object({
		requests: z.array(z.object({
			request: z.object({
				type: z.string().optional(),
				request: z.object({ url: z.string().optional() }).passthrough().optional(),
			}).passthrough().optional(),
			response: z.object({
				hash: z.string().optional(),
				dataLength: z.number().optional(),
				response: z.object({ status: z.number().optional(), mimeType: z.string().optional() }).passthrough().optional(),
			}).passthrough().optional(),
		}).passthrough()),
	}).passthrough(),
}).passthrough();

/** One response a urlscan scan recorded. */
export type UrlscanResponse = { url: string; type: string; status: number; mimeType: string; sha256: string; size: number };

function headers(dependencies: UrlscanDependencies): Record<string, string> {
	const apiKey = dependencies.apiKey ?? process.env.URLSCAN_API_KEY;
	return {
		Accept: "application/json",
		...(apiKey ? { "API-Key": apiKey } : {}),
		"User-Agent": "phishing.support-origin-discovery/1.0 (+https://phishing.support)",
	};
}

const LIMITS = { timeoutMs: 15_000, attempts: 2, retryDelayMs: 1_000, maxResponseBytes: 4 * 1024 * 1024 } as const;

export async function searchUrlscan(query: string, size: number, dependencies: UrlscanDependencies = {}, extra: Record<string, string> = {}): Promise<UrlscanSearchResponse> {
	const params = new URLSearchParams({ q: query, size: String(size), ...extra });
	const response = await fetchJson<unknown>(`${URLSCAN_API}/api/v1/search/?${params}`, { method: "GET", headers: headers(dependencies) }, { fetch: dependencies.fetch, ...LIMITS });
	const parsed = searchResponseSchema.safeParse(response);
	if (!parsed.success) throw new Error("urlscan returned an invalid search response.");
	return parsed.data;
}

/** Every response a scan recorded that has a body hash. */
export async function urlscanResponses(scanId: string, dependencies: UrlscanDependencies = {}): Promise<UrlscanResponse[]> {
	const response = await fetchJson<unknown>(`${URLSCAN_API}/api/v1/result/${encodeURIComponent(scanId)}/`, { method: "GET", headers: headers(dependencies) }, { fetch: dependencies.fetch, ...LIMITS, maxResponseBytes: 16 * 1024 * 1024 });
	const parsed = resultSchema.safeParse(response);
	if (!parsed.success) throw new Error("urlscan returned an invalid scan result.");
	return parsed.data.data.requests.flatMap(({ request, response: answer }) => {
		const url = request?.request?.url;
		const sha256 = answer?.hash?.toLowerCase();
		if (!url || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) return [];
		return [{
			url,
			type: (request?.type ?? "other").toLowerCase(),
			status: answer?.response?.status ?? 0,
			mimeType: (answer?.response?.mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase(),
			sha256,
			size: answer?.dataLength ?? 0,
		}];
	});
}

/** The page DOM the scan ended on, as HTML. */
export async function urlscanDom(scanId: string, dependencies: UrlscanDependencies = {}): Promise<string> {
	return (await fetchText(`${URLSCAN_API}/dom/${encodeURIComponent(scanId)}/`, { method: "GET", headers: headers(dependencies) }, { fetch: dependencies.fetch, ...LIMITS })) ?? "";
}
