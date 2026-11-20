import { createHash } from "node:crypto";

/** The SHA-256 of text or bytes, as lowercase hex. */
export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON is used for immutable request/run hashes and never for display. */
function stableJsonValue(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		// JSON.stringify turns non-finite numbers into null. Preserve that
		// familiar JSON behavior while still producing a valid canonical value.
		return Number.isFinite(value) ? JSON.stringify(value) : "null";
	}
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (typeof value !== "object") throw new TypeError(`Cannot create stable JSON for ${typeof value}.`);
	if (Array.isArray(value)) return `[${value.map((item) => stableJsonValue(item) ?? "null").join(",")}]`;
	if (value instanceof Date) return JSON.stringify(value.toJSON());
	if (Buffer.isBuffer(value)) return JSON.stringify(value.toString("base64"));
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.flatMap((key) => {
			const encoded = stableJsonValue(record[key]);
			// Match JSON.stringify: object properties whose value is undefined are
			// omitted rather than emitting the invalid token `undefined`.
			return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
		});
	return `{${entries.join(",")}}`;
}

export function stableJson(value: unknown): string {
	return stableJsonValue(value) ?? "null";
}

export function hashStableJson(value: unknown): string {
	return sha256Hex(stableJson(value));
}
