
import type { ProviderCorrespondence } from "../submission_contracts";
import { ERANET_PROVIDER } from "./definition";
import { asRecord, parseJsonRecord } from "../../../util/values";
import { snippet } from "../../../util/text";
import { fetchAs, type FetchLike } from "../../../http/fetch";
import { browserUserAgent } from "../../../network/service_identity";

/**
 * Eranet's review stages, in the order its "Query Progress" page numbers them
 * (`status` 1–5; labels from its web bundle, 2026-11-16).
 */
const ERANET_STATES = ["submitted", "material auditing", "supplement required", "processing", "process completed"] as const;

/**
 * Read a filed complaint's record by its receipt. Eranet answers in its own
 * portal, not by mail: its notices only say the status changed (production
 * receipt 900c40f7-944e-4944-a327-4b039439b8e4, keychainagent.pro: "The domain
 * has been hold."). The portal's lookup takes the receipt and the reporter's
 * mailbox, and needs no session.
 */
export async function fetchEranetCorrespondence(
	context: { confirmationId: string; signal?: AbortSignal },
	dependencies: { fetch?: FetchLike } = {},
): Promise<ProviderCorrespondence> {
	// The portal page's own lookup, so it goes out as that page's browser.
	const response = await fetchAs(browserUserAgent, dependencies.fetch)(`${ERANET_PROVIDER.apiBaseUrl}/DescribeInstanceByOrderNo`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({ OrderNo: context.confirmationId, Email: ERANET_PROVIDER.reporter.email }),
		redirect: "error",
		...(context.signal ? { signal: context.signal } : {}),
	});
	const text = await response.text();
	const body = parseJsonRecord(text);
	const record = asRecord(body?.Data);
	if (!response.ok || !record) throw new Error(`Eranet complaint lookup for ${context.confirmationId} failed with HTTP ${response.status}: ${snippet(text)}`);
	if (record.order_no !== context.confirmationId) throw new Error(`Eranet answered the lookup for ${context.confirmationId} with another complaint.`);
	const state = typeof record.status === "number" ? ERANET_STATES[record.status - 1] : undefined;
	// The outcome once processed; while Eranet waits on us, what it asks for.
	const detail = [record.process_result, record.review_remark].find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
	return { messages: [], ...(state ? { status: { state, ...(detail ? { detail } : {}) } } : {}) };
}
