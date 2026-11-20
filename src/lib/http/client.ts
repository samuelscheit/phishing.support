import { isRecord } from "../util/values";

export type PostResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * POST to one of our own API routes from the browser. A JSON-able `body` is
 * sent as JSON, a `FormData` as multipart. Never throws: a failed request, a
 * non-2xx answer and an unreadable body all come back as `{ ok: false }`,
 * carrying the route's `error` text when it sent one, else `failure` with the
 * HTTP status when there was an answer.
 */
export async function postJson<T = unknown>(url: string, body?: unknown, failure = "The request failed."): Promise<PostResult<T>> {
	const init: RequestInit = body === undefined ? { method: "POST" } : body instanceof FormData ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	const response = await fetch(url, init).catch(() => undefined);
	const data: unknown = await response?.json().catch(() => undefined);
	if (response?.ok) return { ok: true, data: data as T };
	const served = isRecord(data) && typeof data.error === "string" && data.error ? data.error : undefined;
	return { ok: false, error: served ?? (response ? `${failure} (${response.status})` : failure) };
}
