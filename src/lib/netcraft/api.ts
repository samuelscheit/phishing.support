export const NETCRAFT_REPORT_URLS_URL = "https://report.netcraft.com/api/v3/report/urls";
export const NETCRAFT_REPORT_MAIL_URL = "https://report.netcraft.com/api/v3/report/mail";
export const NETCRAFT_SUBMISSION_URL_PREFIX = "https://report.netcraft.com/api/v3/submission/";
export const NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES = 20 * 1024 * 1024;
const NETCRAFT_STATUS_REQUEST_TIMEOUT_MS = 15_000;
const NETCRAFT_STATUS_MAX_BODY_BYTES = 256 * 1024;
const NETCRAFT_STATUS_MAX_STATE_LENGTH = 64;
const NETCRAFT_STATUS_MAX_URL_LENGTH = 8_192;

// Netcraft's published schema marks the submission identifier as `format:
// uuid`, while its own examples use a compact 32-hex representation. The live
// API also returns opaque, case-sensitive 32-character alphanumeric IDs (for
// example `lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV`). Accept only these bounded
// identifier forms and construct the status URL ourselves; never follow a
// provider-supplied URL.
const NETCRAFT_COMPACT_SUBMISSION_ID = /^[a-f0-9]{32}$/i;
const NETCRAFT_HYPHENATED_SUBMISSION_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const NETCRAFT_OPAQUE_SUBMISSION_ID = /^[A-Za-z0-9]{32}$/;

export type NetcraftFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type NetcraftSubmissionReceipt = {
	uuid: string;
	message?: string;
	submissionUrl: string;
};

export type NetcraftSubmissionUrlStatus = {
	url: string;
	state?: string;
};

/** Minimal, bounded status data used for a read-only reconciliation. */
export type NetcraftSubmissionStatus = {
	uuid: string;
	state: string;
	pending: boolean;
	hasUrls: boolean;
	lastUpdate?: number;
	urls: NetcraftSubmissionUrlStatus[];
};

/** An explicit 4xx response is a known provider outcome, unlike a lost response. */
export class NetcraftSubmissionRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NetcraftSubmissionRejectedError";
	}
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeSubmissionId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const uuid = value.trim();
	// Compact and RFC-4122 UUID serializations are hexadecimal and historically
	// normalized to lowercase by this integration. Opaque Netcraft receipts are
	// Base62-like and case-sensitive, so preserve their exact provider spelling.
	if (NETCRAFT_COMPACT_SUBMISSION_ID.test(uuid) || NETCRAFT_HYPHENATED_SUBMISSION_ID.test(uuid)) return uuid.toLowerCase();
	if (NETCRAFT_OPAQUE_SUBMISSION_ID.test(uuid)) return uuid;
	return undefined;
}

/** Extract a provider submission identifier from our bounded diagnostic text. */
export function netcraftSubmissionIdFromDiagnostic(value: string): string | undefined {
	if (typeof value !== "string") return undefined;
	// Diagnostics are normally a raw JSON response, but some loggers escape
	// quotes once more while serializing an Error. Accept either representation
	// and still run the extracted value through the strict ID validator.
	let normalized = value;
	for (let pass = 0; pass < 3; pass++) {
		const unescaped = normalized.replaceAll('\\"', '"');
		if (unescaped === normalized) break;
		normalized = unescaped;
	}
	const match = normalized.match(/["']uuid["']\s*:\s*["']([^"']+)["']/i);
	return match ? normalizeSubmissionId(match[1]) : undefined;
}

function parsedReportedResponse(value: unknown): { uuid: string; message?: string } | undefined {
	const record = recordValue(value);
	const uuid = record ? normalizeSubmissionId(record.uuid) : undefined;
	if (!record || !uuid || (record.message !== undefined && typeof record.message !== "string")) {
		return undefined;
	}
	return {
		uuid,
		...(typeof record.message === "string" && record.message.trim() ? { message: record.message.trim() } : {}),
	};
}

function responseDetail(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 1_000) || "No further detail was returned.";
}

/** Construct Netcraft's fixed v3 status endpoint from a confirmed UUID only. */
export function netcraftSubmissionUrl(uuid: string): string {
	const normalized = normalizeSubmissionId(uuid);
	if (!normalized) throw new Error("Netcraft returned an invalid submission UUID.");
	return new URL(normalized, NETCRAFT_SUBMISSION_URL_PREFIX).toString();
}

/** Construct the fixed URL-list endpoint from a validated submission ID. */
export function netcraftSubmissionUrlsUrl(uuid: string): string {
	return `${netcraftSubmissionUrl(uuid)}/urls`;
}

function booleanFlag(value: unknown): boolean | undefined {
	if (value === true || value === 1 || value === "1") return true;
	if (value === false || value === 0 || value === "0") return false;
	return undefined;
}

function integerFlag(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function parseSubmissionStatus(value: unknown, uuid: string): Omit<NetcraftSubmissionStatus, "urls"> | undefined {
	const record = recordValue(value);
	if (!record || typeof record.state !== "string" || !record.state.trim() || record.state.trim().length > NETCRAFT_STATUS_MAX_STATE_LENGTH) return undefined;
	if (record.uuid !== undefined && normalizeSubmissionId(record.uuid) !== uuid) return undefined;
	if (record.warnings !== undefined && (!Array.isArray(record.warnings) || record.warnings.length > 0)) return undefined;
	const pending = booleanFlag(record.pending);
	const hasUrls = booleanFlag(record.has_urls);
	if (pending === undefined || hasUrls === undefined) return undefined;
	const lastUpdate = record.last_update === null ? undefined : integerFlag(record.last_update);
	if (record.last_update !== undefined && record.last_update !== null && lastUpdate === undefined) return undefined;
	return {
		uuid,
		state: record.state.trim(),
		pending,
		hasUrls,
		...(lastUpdate === undefined ? {} : { lastUpdate }),
	};
}

function parseSubmissionUrls(value: unknown): NetcraftSubmissionUrlStatus[] | undefined {
	const record = recordValue(value);
	if (!record || !Array.isArray(record.urls) || record.urls.length === 0) return undefined;
	const urls: NetcraftSubmissionUrlStatus[] = [];
	for (const item of record.urls) {
		const entry = recordValue(item);
		if (!entry || typeof entry.url !== "string" || !entry.url.trim() || entry.url.trim().length > NETCRAFT_STATUS_MAX_URL_LENGTH) return undefined;
		if (entry.url_state !== undefined && (typeof entry.url_state !== "string" || entry.url_state.trim().length > NETCRAFT_STATUS_MAX_STATE_LENGTH)) return undefined;
		urls.push({ url: entry.url.trim(), ...(typeof entry.url_state === "string" ? { state: entry.url_state.trim() } : {}) });
	}
	return urls;
}

async function fetchNetcraftJson(
	request: NetcraftFetch,
	url: string,
	label: string,
): Promise<unknown> {
	const controller = new AbortController();
	const timeoutError = new Error(`Netcraft ${label} request timed out.`);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(timeoutError);
		}, NETCRAFT_STATUS_REQUEST_TIMEOUT_MS);
	});
	try {
		const response = await Promise.race([
			request(url, {
				method: "GET",
				redirect: "error",
				headers: { accept: "application/json" },
				signal: controller.signal,
			}),
			deadline,
		]);
		const body = await Promise.race([
			response.text(),
			deadline,
		]);
		if (new TextEncoder().encode(body).byteLength > NETCRAFT_STATUS_MAX_BODY_BYTES) {
			throw new Error(`Netcraft ${label} response exceeded the ${NETCRAFT_STATUS_MAX_BODY_BYTES}-byte safety limit.`);
		}
		if (!response.ok) throw new Error(`Netcraft ${label} request failed with HTTP ${response.status}: ${responseDetail(body)}`);
		try {
			return JSON.parse(body);
		} catch {
			throw new Error(`Netcraft ${label} request returned malformed JSON.`);
		}
	} catch (error) {
		if (error === timeoutError || controller.signal.aborted) {
			throw new Error(`Netcraft ${label} request timed out.`);
		}
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

/**
 * Read a Netcraft submission and its URL list without making another report.
 * This is intentionally separate from the POST parser so an operator can
 * repair a durable unknown-external-state run after a response-schema drift.
 */
export async function fetchNetcraftSubmissionStatus(params: {
	uuid: string;
	fetch?: NetcraftFetch;
}): Promise<NetcraftSubmissionStatus> {
	const uuid = normalizeSubmissionId(params.uuid);
	if (!uuid) throw new Error("Netcraft returned an invalid submission UUID.");
	const request = params.fetch ?? fetch;
	const status = parseSubmissionStatus(
		await fetchNetcraftJson(request, netcraftSubmissionUrl(uuid), "submission-status"),
		uuid,
	);
	if (!status) throw new Error("Netcraft submission-status response did not match the reviewed schema.");
	const urls = parseSubmissionUrls(
		await fetchNetcraftJson(request, netcraftSubmissionUrlsUrl(uuid), "submission-URLs"),
	);
	if (!urls) throw new Error("Netcraft submission-URLs response did not match the reviewed schema.");
	return { ...status, urls };
}

/**
 * Parse a Netcraft v3 API response without coupling it to a specific report
 * channel. Malformed 2xx responses and 5xx/network errors stay ambiguous;
 * only explicit client errors are safe terminal rejections.
 */
export async function parseNetcraftSubmissionResponse(
	response: Pick<Response, "ok" | "status" | "text">,
): Promise<NetcraftSubmissionReceipt> {
	const body = await response.text();
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) {
			throw new NetcraftSubmissionRejectedError(
				"Netcraft report was rejected with HTTP " + response.status + ": " + responseDetail(body),
			);
		}
		throw new Error("Netcraft report submission failed with HTTP " + response.status + ": " + responseDetail(body));
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Netcraft report returned a successful HTTP status without a valid JSON confirmation.");
	}
	const accepted = parsedReportedResponse(parsed);
	if (!accepted) {
		// This occurs after the POST boundary. Include the bounded provider body
		// in the durable unknown-state error so operators can distinguish a
		// changed response schema from an ambiguous transport result without
		// replaying a potentially accepted complaint.
		throw new Error("Netcraft report did not include a valid submission UUID: " + responseDetail(body));
	}

	return {
		uuid: accepted.uuid,
		...(accepted.message ? { message: accepted.message } : {}),
		submissionUrl: netcraftSubmissionUrl(accepted.uuid),
	};
}
