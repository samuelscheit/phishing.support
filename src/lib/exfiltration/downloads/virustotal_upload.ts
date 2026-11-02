/** Official VirusTotal v3 upload endpoint, documented for files up to 32 MB. */
const VIRUSTOTAL_UPLOAD_URL = "https://www.virustotal.com/api/v3/files";
/** Largest file POST /files accepts. Larger files need a single-use upload URL, which is not implemented here. */
export const VIRUSTOTAL_DIRECT_UPLOAD_LIMIT_BYTES = 32 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type VirusTotalUploadResult =
	| { state: "submitted"; analysisId: string }
	| { state: "not_attempted"; reason: "too_large" | "not_configured" }
	| { state: "failed"; reason: string };

/**
 * Submit one file for public analysis. The caller has already decided, through the
 * policy, that this file may be uploaded. The filename is fixed to a safe leaf
 * name: the remote name never reaches the request.
 */
export async function uploadToVirusTotal(params: {
	bytes: Buffer;
	apiKey: string | undefined;
	/** A safe leaf name we chose, not the remote file name. */
	fileName: string;
	fetch?: Fetch;
}): Promise<VirusTotalUploadResult> {
	if (!params.apiKey?.trim()) return { state: "not_attempted", reason: "not_configured" };
	if (params.bytes.byteLength > VIRUSTOTAL_DIRECT_UPLOAD_LIMIT_BYTES) return { state: "not_attempted", reason: "too_large" };
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(params.bytes)], { type: "application/octet-stream" }), params.fileName);
	let response: Response;
	try {
		response = await (params.fetch ?? fetch)(VIRUSTOTAL_UPLOAD_URL, {
			method: "POST",
			headers: { "x-apikey": params.apiKey.trim(), accept: "application/json" },
			body: form,
			signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
		});
	} catch {
		return { state: "failed", reason: "transport failure" };
	}
	if (!response.ok) return { state: "failed", reason: `HTTP ${response.status}` };
	const body = await response.json().catch(() => undefined) as { data?: { type?: unknown; id?: unknown } } | undefined;
	if (body?.data?.type !== "analysis" || typeof body.data.id !== "string" || !body.data.id) {
		return { state: "failed", reason: "response is not an analysis object" };
	}
	return { state: "submitted", analysisId: body.data.id };
}
