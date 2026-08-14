export const NETCRAFT_REPORT_URLS_URL = "https://report.netcraft.com/api/v3/report/urls";
export const NETCRAFT_REPORT_MAIL_URL = "https://report.netcraft.com/api/v3/report/mail";
export const NETCRAFT_SUBMISSION_URL_PREFIX = "https://report.netcraft.com/api/v3/submission/";
export const NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES = 20 * 1024 * 1024;

const NETCRAFT_SUBMISSION_ID = /^[a-f0-9]{32}$/i;

export type NetcraftFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type NetcraftSubmissionReceipt = {
	uuid: string;
	message?: string;
	submissionUrl: string;
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

function parsedReportedResponse(value: unknown): { uuid: string; message?: string } | undefined {
	const record = recordValue(value);
	if (!record || typeof record.uuid !== "string" || !NETCRAFT_SUBMISSION_ID.test(record.uuid)
		|| (record.message !== undefined && typeof record.message !== "string")) {
		return undefined;
	}
	return {
		uuid: record.uuid.toLowerCase(),
		...(typeof record.message === "string" && record.message.trim() ? { message: record.message.trim() } : {}),
	};
}

function responseDetail(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 1_000) || "No further detail was returned.";
}

/** Construct Netcraft's fixed v3 status endpoint from a confirmed UUID only. */
export function netcraftSubmissionUrl(uuid: string): string {
	if (!NETCRAFT_SUBMISSION_ID.test(uuid)) throw new Error("Netcraft returned an invalid submission UUID.");
	return new URL(uuid.toLowerCase(), NETCRAFT_SUBMISSION_URL_PREFIX).toString();
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
	if (!accepted) throw new Error("Netcraft report did not include a valid submission UUID.");

	return {
		uuid: accepted.uuid,
		...(accepted.message ? { message: accepted.message } : {}),
		submissionUrl: netcraftSubmissionUrl(accepted.uuid),
	};
}
