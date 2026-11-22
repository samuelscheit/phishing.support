import { fetchJson, RequestTimeoutError } from "../../../network/bounded_fetch";
import { errorText } from "../../../util/error_text";
import { asRecord } from "../../../util/values";
import { snippet } from "../../../util/text";
import { type FetchLike } from "../../../http/fetch";

export const NETCRAFT_REPORT_URLS_URL = "https://report.netcraft.com/api/v3/report/urls";
export const NETCRAFT_REPORT_MAIL_URL = "https://report.netcraft.com/api/v3/report/mail";
export const NETCRAFT_SUBMISSION_URL_PREFIX = "https://report.netcraft.com/api/v3/submission/";
const NETCRAFT_STATUS_REQUEST_TIMEOUT_MS = 15_000;
const NETCRAFT_STATUS_MAX_BODY_BYTES = 256 * 1024;
const NETCRAFT_STATUS_MAX_STATE_LENGTH = 64;

// Netcraft's published schema marks the submission identifier as `format:
// uuid`, while its own examples use a compact 32-hex representation. The live
// API also returns opaque, case-sensitive 32-character alphanumeric IDs (for
// example `lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV`). Accept only these bounded
// identifier forms and construct the status URL ourselves; never follow a
// provider-supplied URL.
const NETCRAFT_COMPACT_SUBMISSION_ID = /^[a-f0-9]{32}$/i;
const NETCRAFT_HYPHENATED_SUBMISSION_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const NETCRAFT_OPAQUE_SUBMISSION_ID = /^[A-Za-z0-9]{32}$/;

export type NetcraftSubmissionReceipt = {
	uuid: string;
	message?: string;
	submissionUrl: string;
};

/** A submission's review state, read without making another report. */
export type NetcraftSubmissionState = {
	uuid: string;
	state: string;
	pending: boolean;
	hasUrls: boolean;
	lastUpdate?: number;
};

/** An explicit 4xx response is a known provider outcome, unlike a lost response. */
export class NetcraftSubmissionRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NetcraftSubmissionRejectedError";
	}
}

/** Netcraft's answer to URLs it has a recent submission for: they are reported. */
export class NetcraftDuplicateSubmissionError extends NetcraftSubmissionRejectedError {
	constructor(message: string) {
		super(message);
		this.name = "NetcraftDuplicateSubmissionError";
	}
}

const DUPLICATE_MESSAGE = "Duplicate of a recent submission";

/** Whether a 4xx answer is exactly Netcraft's duplicate answer: HTTP 400 whose every detail says so. */
export function isNetcraftDuplicateAnswer(status: number, body: string): boolean {
	if (status !== 400) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return false;
	}
	const details = asRecord(parsed)?.details;
	return Array.isArray(details) && details.length > 0 && details.every((detail) => asRecord(detail)?.message === DUPLICATE_MESSAGE);
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

/**
 * Submission IDs named by `report.netcraft.com/submission/<id>` links, as
 * Netcraft's report-update emails carry them.
 */
export function netcraftSubmissionIdsFromText(text: string): string[] {
	return [...new Set([...text.matchAll(/report\.netcraft\.com\/(?:api\/v3\/)?submission\/([A-Za-z0-9-]{32,36})\b/g)]
		.map((match) => normalizeSubmissionId(match[1]))
		.filter((id): id is string => Boolean(id)))];
}

function parsedReportedResponse(value: unknown): { uuid: string; message?: string } | undefined {
	const record = asRecord(value);
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
	return snippet(body, 1_000) || "No further detail was returned.";
}

/** Construct Netcraft's fixed v3 status endpoint from a confirmed UUID only. */
export function netcraftSubmissionUrl(uuid: string): string {
	const normalized = normalizeSubmissionId(uuid);
	if (!normalized) throw new Error("Netcraft returned an invalid submission UUID.");
	return new URL(normalized, NETCRAFT_SUBMISSION_URL_PREFIX).toString();
}

function booleanFlag(value: unknown): boolean | undefined {
	if (value === true || value === 1 || value === "1") return true;
	if (value === false || value === 0 || value === "0") return false;
	return undefined;
}

function integerFlag(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function parseSubmissionStatus(value: unknown, uuid: string): NetcraftSubmissionState | undefined {
	const record = asRecord(value);
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

async function fetchNetcraftJson(
	request: FetchLike,
	url: string,
	label: string,
): Promise<unknown> {
	try {
		// Reuse the shared streaming reader/deadline so a provider response cannot
		// consume unbounded memory while `response.text()` waits for EOF. A GET is
		// not retried here: one auditable read per call.
		return await fetchJson<unknown>(url, {
			method: "GET",
			redirect: "error",
			headers: { accept: "application/json" },
		}, {
			fetch: request as FetchLike,
			timeoutMs: NETCRAFT_STATUS_REQUEST_TIMEOUT_MS,
			attempts: 1,
			retryDelayMs: 0,
			maxResponseBytes: NETCRAFT_STATUS_MAX_BODY_BYTES,
		});
	} catch (error) {
		if (error instanceof RequestTimeoutError) {
			throw new Error(`Netcraft ${label} request timed out.`);
		}
		const message = errorText(error);
		if (/not valid JSON/i.test(message)) throw new Error(`Netcraft ${label} request returned malformed JSON.`);
		throw new Error(`Netcraft ${label} request failed: ${message}`);
	}
}

/** Read a submission's review state: one auditable GET, never another report. */
export async function fetchNetcraftSubmissionState(params: {
	uuid: string;
	fetch?: FetchLike;
}): Promise<NetcraftSubmissionState> {
	const uuid = normalizeSubmissionId(params.uuid);
	if (!uuid) throw new Error("Netcraft returned an invalid submission UUID.");
	const status = parseSubmissionStatus(
		await fetchNetcraftJson(params.fetch ?? fetch, netcraftSubmissionUrl(uuid), "submission-status"),
		uuid,
	);
	if (!status) throw new Error("Netcraft submission-status response did not match the reviewed schema.");
	return status;
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
			const message = "Netcraft report was rejected with HTTP " + response.status + ": " + responseDetail(body);
			throw isNetcraftDuplicateAnswer(response.status, body) ? new NetcraftDuplicateSubmissionError(message) : new NetcraftSubmissionRejectedError(message);
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
