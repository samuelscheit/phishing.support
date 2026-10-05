import { asArray, asRecord } from "./records";
import type { JsonRecord } from "./types";

/** Extract unique, valid origin ASNs from the RIPE network-info response. */
export function originAsns(ripe: JsonRecord | undefined): number[] {
	const data = asRecord(ripe?.data);
	const values = asArray(data?.asns);
	const results: number[] = [];
	for (const value of values) {
		const normalized = String(value).trim().replace(/^AS/i, "");
		if (!/^\d+$/.test(normalized)) continue;
		const asn = Number(normalized);
		if (Number.isSafeInteger(asn) && asn >= 0 && asn <= 4_294_967_295 && !results.includes(asn)) results.push(asn);
	}
	return results;
}
