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

/**
 * An external error's text with credential-shaped parts removed, for storing
 * or logging: key and authorization assignments, bearer tokens, and the
 * signature and credential parameters of a signed URL. The placeholder keeps
 * the name it hid; the text is bounded.
 */
export function redactedErrorText(error: unknown): string {
	// Bearer tokens first: the assignment rule below would otherwise consume the word
	// "Bearer" as the value of an Authorization header and leave the token behind.
	return errorText(error)
		.replace(/\bbearer\s+[^\s,;]+/gi, "Bearer [redacted]")
		.replace(/\b(api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
		.replace(/\b(X-Amz-(?:Signature|Credential|Security-Token)|Signature|token|sig)=[^&\s]+/gi, "$1=[redacted]")
		.slice(0, 2_000);
}

/** One line of at most 500 characters, for error lists stored in snapshots and logs. */
export function errorSummary(error: unknown): string {
	return errorText(error).replace(/\s+/g, " ").slice(0, 500);
}
