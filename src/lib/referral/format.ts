/** Small text helpers shared by the German complaint mails and the English evidence archive. */

export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
