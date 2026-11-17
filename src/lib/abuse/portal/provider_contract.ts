import { normalizeDomain } from "../security";

export function boundedString(value: unknown, maximum: number, minimum = 0): value is string {
	return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

/**
 * Normalize a code-owned provider-domain allowlist without silently dropping
 * malformed entries. Silently filtering a bad entry would make an output
 * contract depend on whichever subset happened to parse, which is unsafe for
 * an irreversible provider submission.
 */
export function normalizeAllowedDomains(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const normalized: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		const domain = normalizeDomain(item);
		if (!domain) return undefined;
		if (!normalized.includes(domain)) normalized.push(domain);
	}
	return normalized.length > 0 ? normalized : undefined;
}

function hostBelongsToAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
	const host = normalizeDomain(hostname);
	return Boolean(host && allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
}

/**
 * Parse the only URL shape accepted in a completed provider output. Entry
 * URLs and final URLs use the same helper so a generic adapter cannot start
 * on a URL that the completion contract would reject later.
 */
export function exactAllowedHttpsUrl(value: unknown, allowedDomains: string[]): URL | undefined {
	if (!boundedString(value, 4_096) || allowedDomains.length === 0) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return undefined;
		if (!hostBelongsToAllowedDomain(url.hostname, allowedDomains)) return undefined;
		const normalizedHost = normalizeDomain(url.hostname);
		if (!normalizedHost) return undefined;
		url.hostname = normalizedHost;
		return url;
	} catch {
		return undefined;
	}
}

export function exactStringSet(value: unknown, expected: string[]): boolean {
	if (!Array.isArray(value) || value.some((item) => !boundedString(item, 4_096))) return false;
	if (new Set(value).size !== value.length || new Set(expected).size !== expected.length) return false;
	const actual = [...value].sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((item, index) => item === wanted[index]);
}

export function isExactAllowedFinalUrl(value: unknown, allowedDomains: string[]): boolean {
	return Boolean(exactAllowedHttpsUrl(value, allowedDomains));
}
