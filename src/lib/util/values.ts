/**
 * Reading values whose shape is not guaranteed: stored JSON evidence, API
 * answers, model output. One set of helpers instead of a copy per module.
 */

export type JsonRecord = Record<string, unknown>;

/** Whether a value is a plain object (not an array, not null). */
export function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as an object, or undefined. */
export function asRecord(value: unknown): JsonRecord | undefined {
	return isRecord(value) ? value : undefined;
}

/** The value's fields, or none: for reading nested optional evidence without checks at every step. */
export function record(value: unknown): JsonRecord {
	return isRecord(value) ? value : {};
}

/** The parsed JSON, or undefined when the text is no JSON. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** A JSON object in text (an HTTP body), or undefined when the text is no JSON object. */
export function parseJsonRecord(text: string): JsonRecord | undefined {
	return asRecord(parseJson(text));
}

/** A non-empty string, trimmed, or undefined. */
export function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A finite number, or undefined. */
export function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** "1 site", "3 sites". */
export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}
