import type { JsonRecord } from "./types";

export function asRecord(value: unknown): JsonRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function normalizeMailbox(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const candidate = value.trim().replace(/^<|>$/g, "").toLowerCase();
	if (candidate.length > 320) return undefined;
	if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(candidate)) {
		return undefined;
	}
	return candidate;
}
