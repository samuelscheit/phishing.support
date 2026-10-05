import { normalizeMailbox, uniqueStrings } from "./records";
import type { JsonRecord } from "./types";

function extractWhoisValues(raw: string, labels: RegExp[]): string[] {
	const values: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		for (const label of labels) {
			const matched = line.match(label);
			if (!matched?.[1]) continue;
			values.push(matched[1].trim());
			break;
		}
	}
	return values;
}

/**
 * Port-43 data is intentionally parsed narrowly. An arbitrary `email:` field
 * is not an abuse contact; only a field whose label explicitly says abuse is
 * eligible for an external recipient.
 */
export function parseExplicitWhoisAbuseMailboxes(raw: string): string[] {
	const labels = [
		/^\s*abuse-mailbox\s*:\s*(.+?)\s*$/i,
		/^\s*abuse(?:\s+(?:contact\s+)?)?(?:e-?mail|email)\s*:\s*(.+?)\s*$/i,
		/^\s*registrar\s+abuse\s+contact\s+(?:e-?mail|email)\s*:\s*(.+?)\s*$/i,
	];
	const values = extractWhoisValues(raw, labels).flatMap((value) => value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
	return uniqueStrings(values.map((value) => normalizeMailbox(value)));
}

export function parseWhoisNetworkMetadata(raw: string): JsonRecord {
	const first = (labels: RegExp[]) => extractWhoisValues(raw, labels)[0];
	return {
		netname: first([/^\s*netname\s*:\s*(.+?)\s*$/i]),
		descriptions: extractWhoisValues(raw, [/^\s*(?:descr|description)\s*:\s*(.+?)\s*$/i]).slice(0, 30),
		organization: first([/^\s*(?:org(?:anisation|anization)?|owner)\s*:\s*(.+?)\s*$/i]),
	};
}
