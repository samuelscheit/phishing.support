/**
 * Metadata captured when a report is submitted from the web UI.
 *
 * Headers are persisted as JSON, so values can arrive as a plain object,
 * an array of entries, or (when called from a browser-only context) a native
 * Headers instance. Keep this type deliberately permissive at the boundary
 * and normalize it before using it in the UI.
 */
export type ReporterHeaders =
	| Record<string, unknown>
	| Array<[string, unknown]>
	| Headers
	| string
	| null
	| undefined;

export type ReporterMetadata = {
	reporterCountry?: string | null;
	reporterHeaders?: ReporterHeaders;
};

const userAgentHeaderNames = ["user-agent", "x-user-agent"] as const;

const modelHeaderNames = ["sec-ch-ua-model", "x-device-model", "device-model", "user-agent-model"] as const;

function asHeaderEntries(headers: ReporterHeaders): Array<[string, unknown]> {
	if (!headers) return [];

	if (typeof headers === "string") {
		const value = headers.trim();
		if (!value) return [];

		// A JSON string can be produced when a caller serializes headers twice.
		if (value.startsWith("{") || value.startsWith("[")) {
			try {
				return asHeaderEntries(JSON.parse(value) as ReporterHeaders);
			} catch {
				// Treat a non-JSON string as a raw user-agent below.
			}
		}

		return [["user-agent", value]];
	}

	if (typeof Headers !== "undefined" && headers instanceof Headers) {
		return Array.from(headers.entries());
	}

	if (Array.isArray(headers)) {
		return headers.filter((entry): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === "string");
	}

	if (typeof headers === "object") {
		return Object.entries(headers);
	}

	return [];
}

/** Return a persisted header value using case-insensitive header names. */
export function getReporterHeader(headers: ReporterHeaders, name: string): string | undefined {
	const wanted = name.toLowerCase();
	const entry = asHeaderEntries(headers).find(([key]) => key.toLowerCase() === wanted);
	if (!entry) return undefined;

	const value = entry[1];
	if (Array.isArray(value)) {
		const first = value.find((item) => item !== null && item !== undefined);
		return first === undefined ? undefined : String(first).trim() || undefined;
	}
	if (value === null || value === undefined) return undefined;
	return String(value).trim() || undefined;
}

function firstReporterHeader(headers: ReporterHeaders, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = getReporterHeader(headers, name);
		if (value) return value;
	}
	return undefined;
}

/** Extract the raw user-agent header from persisted reporter headers. */
export function getReporterUserAgent(headers: ReporterHeaders): string | undefined {
	return firstReporterHeader(headers, userAgentHeaderNames);
}

/** Whether a persisted header value contains any usable entries. */
export function hasReporterHeaders(headers: ReporterHeaders): boolean {
	if (!headers) return false;
	if (typeof headers === "string") return headers.trim().length > 0;
	if (typeof Headers !== "undefined" && headers instanceof Headers) return [...headers.keys()].length > 0;
	if (Array.isArray(headers)) return headers.some((entry) => Array.isArray(entry) && typeof entry[0] === "string");
	return typeof headers === "object" && Object.keys(headers).length > 0;
}

function cleanModel(value: string): string | undefined {
	const model = value.replace(/^['"]|['"]$/g, "").trim();
	if (!model || model === "?0" || /^unknown$/i.test(model)) return undefined;
	const cleaned = model.replace(/\s+Build\/[^\s;)]+/i, "").trim();
	// Some clients expose Apple identifiers such as `iPhone17,1`; add a
	// separator so the value reads naturally without guessing the retail model.
	return cleaned.replace(/^(iPhone|iPad)(?=\d)/i, "$1 ") || undefined;
}

function androidModel(userAgent: string): string | undefined {
	// Android UAs normally look like `Android 14; Pixel 8 Pro Build/...`.
	const match = userAgent.match(/Android[^;)]*;\s*(?:[^;()]+;\s*)?([^;)]+?)(?:\s+Build[\\/;][^)]*)?[)]/i);
	return match?.[1] ? cleanModel(match[1]) : undefined;
}

function browserName(userAgent: string): string | undefined {
	if (/Edg\//i.test(userAgent)) return "Edge";
	if (/OPR\//i.test(userAgent)) return "Opera";
	if (/Firefox\//i.test(userAgent)) return "Firefox";
	if (/CriOS\//i.test(userAgent) || /Chrome\//i.test(userAgent)) return "Chrome";
	if (/FxiOS\//i.test(userAgent)) return "Firefox";
	if (/Safari\//i.test(userAgent)) return "Safari";
	return undefined;
}

/**
 * Convert a raw browser user-agent into a short, human-readable device label.
 * Client-hint model headers are preferred because traditional iPhone UAs do
 * not expose the model generation (for example, `iPhone 17`).
 */
export function readableUserAgent(headersOrUserAgent: ReporterHeaders | string | null): string {
	const explicitModel = typeof headersOrUserAgent === "string" ? undefined : firstReporterHeader(headersOrUserAgent, modelHeaderNames);
	if (explicitModel) return cleanModel(explicitModel) || "Unknown device";

	const userAgent = typeof headersOrUserAgent === "string" ? headersOrUserAgent.trim() : getReporterUserAgent(headersOrUserAgent);
	if (!userAgent) return "Unknown device";

	if (/iPhone/i.test(userAgent)) {
		const model = userAgent.match(/iPhone\s*([0-9][\w,.-]*)?/i)?.[1];
		return model ? `iPhone ${model.trim()}` : "iPhone";
	}
	if (/iPad/i.test(userAgent)) return "iPad";

	const android = androidModel(userAgent);
	if (android) return android;
	if (/CrOS/i.test(userAgent)) return "Chromebook";
	if (/Windows NT/i.test(userAgent)) return "Windows PC";
	if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
	if (/Linux/i.test(userAgent)) return "Linux PC";

	const browser = browserName(userAgent);
	return browser ? `${browser} browser` : "Unknown device";
}

/** Normalize a country code for flag and display-name lookup. */
export function normalizeCountryCode(country: string | null | undefined): string | undefined {
	const code = country?.trim().toUpperCase();
	return code && /^[A-Z]{2}$/.test(code) ? code : undefined;
}

/** Convert an ISO 3166-1 alpha-2 code to its regional-indicator emoji flag. */
export function countryFlag(country: string | null | undefined): string | undefined {
	const code = normalizeCountryCode(country);
	if (!code) return undefined;
	return String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

/** Resolve the English country name used by the country tooltip. */
export function countryName(country: string | null | undefined): string | undefined {
	const code = normalizeCountryCode(country);
	if (!code) return undefined;

	try {
		const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
		return displayNames.of(code) || code;
	} catch {
		return code;
	}
}
