/** Shared validation for the non-secret Fabric browser-session lifecycle ID. */
export const FABRIC_BROWSER_SESSION_ID_PATTERN = /^browser-session_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;

export function isFabricBrowserSessionId(value: unknown): value is string {
	return typeof value === "string" && FABRIC_BROWSER_SESSION_ID_PATTERN.test(value);
}

/**
 * Provider-run payloads may retain only the opaque Fabric session ID needed to
 * heartbeat, release, or cancel an already-created dynamic Skyvern browser.
 * Capabilities, endpoints, cookies, and other browser data are never durable.
 */
export function fabricBrowserSessionIdFromProviderPayload(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = (value as Record<string, unknown>).__fabricBrowserSessionId;
	return isFabricBrowserSessionId(candidate) ? candidate : undefined;
}
