import { isIP } from "node:net";

/**
 * Metadata captured at the HTTP boundary for a submission.
 *
 * Internal submission sources (for example the IMAP listener) do not have a
 * request and therefore leave these values unset.
 */
export type ReporterMetadata = {
	reporterIp?: string;
	reporterCountry?: string;
	reporterHeaders?: Record<string, string>;
};

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * Normalize an ISO-3166 alpha-2 country code. Cloudflare uses `XX` for an
 * unknown country and `T1` for Tor traffic; neither is useful as a country in
 * the UI, so treat them as unavailable.
 */
export function normalizeCountryCode(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;

	const code = value.trim().toUpperCase();
	if (!COUNTRY_CODE_PATTERN.test(code) || code === "XX" || code === "T1") return undefined;
	return code;
}

function normalizeForwardedIp(value: string): string | undefined {
	let candidate = value.trim();
	if (!candidate) return undefined;

	// RFC 7239's Forwarded header can be supplied by some proxies.
	const forwarded = candidate.match(/^for\s*=\s*(?:"([^"\s]+)"|([^;\s]+))/i);
	if (forwarded) candidate = forwarded[1] ?? forwarded[2] ?? "";

	// Remove optional brackets around an IPv6 address and an optional port. Do
	// not strip colons from an unbracketed IPv6 address.
	if (candidate.startsWith("[") && candidate.includes("]")) {
		candidate = candidate.slice(1, candidate.indexOf("]"));
	} else if (isIP(candidate) === 0 && /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
		candidate = candidate.slice(0, candidate.lastIndexOf(":"));
	}

	// A quoted value may still contain quotes after the Forwarded parsing above.
	candidate = candidate.replace(/^['"]|['"]$/g, "").trim();
	return isIP(candidate) > 0 ? candidate : undefined;
}

function stripForwardedIp(value: string): string | undefined {
	// `X-Forwarded-For` can contain malformed hops. Keep the original-client
	// ordering, but skip invalid entries instead of discarding a valid later one.
	for (const candidate of value.split(",")) {
		const ip = normalizeForwardedIp(candidate);
		if (ip) return ip;
	}

	return undefined;
}

/**
 * Return the best client IP available from the proxy headers used by the
 * deployment. Header names are case-insensitive through the Fetch Headers API.
 */
export function getClientIp(req: Request): string | undefined {
	const candidates = [
		req.headers.get("cf-connecting-ip"),
		req.headers.get("x-forwarded-for"),
		req.headers.get("x-real-ip"),
		req.headers.get("forwarded"),
	];

	for (const value of candidates) {
		if (!value) continue;
		const ip = stripForwardedIp(value);
		if (ip) return ip;
	}

	return undefined;
}

function requestHeaders(req: Request): Record<string, string> {
	return Object.fromEntries(req.headers.entries());
}

async function lookupCountryCode(ip: string): Promise<string | undefined> {
	try {
		const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(3000) : undefined;
		const response = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, {
			headers: { accept: "application/json" },
			signal: timeout,
		});
		if (!response.ok) return undefined;

		const payload: unknown = await response.json();
		if (!payload || typeof payload !== "object" || !("country" in payload)) return undefined;
		return normalizeCountryCode((payload as { country?: unknown }).country);
	} catch {
		// Reporting must not fail because geolocation is unavailable. The IP and
		// original request headers are still persisted.
		return undefined;
	}
}

/**
 * Capture request-level reporter metadata. Cloudflare's country header is
 * authoritative when present; otherwise derive the country from the client IP
 * through country.is.
 */
export async function getReporterMetadata(req: Request): Promise<ReporterMetadata> {
	const reporterIp = getClientIp(req);
	const reporterCountry =
		normalizeCountryCode(req.headers.get("cf-ipcountry")) ?? (reporterIp ? await lookupCountryCode(reporterIp) : undefined);

	return {
		reporterIp,
		reporterCountry,
		reporterHeaders: requestHeaders(req),
	};
}
