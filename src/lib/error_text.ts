/**
 * A readable description of anything thrown. WebSocket clients reject with an
 * `ErrorEvent` (puppeteer under Bun does), which is not an `Error` and
 * stringifies to "[object ErrorEvent]"; its cause sits in `error`/`message`.
 */
export function errorText(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	if (error && typeof error === "object") {
		const record = error as { message?: unknown; error?: unknown; reason?: unknown; type?: unknown };
		if (record.error instanceof Error && record.error.message) return record.error.message;
		for (const value of [record.message, record.reason]) if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof record.type === "string") return `${error.constructor?.name ?? "Event"} (${record.type})`;
		try {
			const json = JSON.stringify(error);
			if (json && json !== "{}") return json;
		} catch {
			// Fall through to the tag name.
		}
	}
	return String(error);
}

/** An `Error` for anything thrown, keeping the original as its cause. */
export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(errorText(error), { cause: error });
}

/** One line of at most 500 characters, for error lists stored in snapshots and logs. */
export function errorSummary(error: unknown): string {
	return errorText(error).replace(/\s+/g, " ").slice(0, 500);
}
