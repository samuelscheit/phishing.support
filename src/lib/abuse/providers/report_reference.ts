import { abuseCaseTag } from "../mail/correlation";
import { asRecord } from "../../util/values";

/** Our reference for one route's report: the case tag (the one our mail uses) and the route. */
export function reportReference(reportId: bigint, routeId: bigint): string {
	return `${abuseCaseTag(reportId)}-R${routeId.toString()}`;
}

/** Whether a value is exactly a reference `reportReference` writes, within `maximumLength`. */
export function isReportReference(value: unknown, maximumLength = Number.POSITIVE_INFINITY): value is string {
	return typeof value === "string" && value.length <= maximumLength && /^PS-[0-9a-f]{12}-R\d{1,20}$/.test(value);
}

/** Our references in untrusted text, as `reportReference` writes them. */
export function reportReferencesIn(text: string): string[] {
	return [...new Set([...text.matchAll(/\bPS-([0-9a-f]{12})-R(\d{1,20})\b/gi)].map((match) => `PS-${match[1]!.toLowerCase()}-R${match[2]!}`))];
}

/** Keys a provider's answer might name its case under; a form's answer shape is rarely documented. */
const RESPONSE_ID_KEYS = ["caseId", "case_id", "caseNumber", "case_number", "displayId", "display_id", "ticketId", "ticket_id", "reportId", "report_id", "id"];
const RESPONSE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/** A case or ticket ID in a provider's JSON answer, when it names one; never required. */
export function providerResponseId(data: unknown): string | undefined {
	if (typeof data === "string" || typeof data === "number") return RESPONSE_ID_PATTERN.test(String(data)) ? String(data) : undefined;
	const record = asRecord(data);
	if (!record) return undefined;
	for (const key of RESPONSE_ID_KEYS) {
		const value = record[key];
		if ((typeof value === "string" || typeof value === "number") && RESPONSE_ID_PATTERN.test(String(value))) return String(value);
	}
	return undefined;
}
