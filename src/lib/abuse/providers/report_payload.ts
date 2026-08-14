import { domainMatchesOrIsSubdomain, normalizeDomain } from "../security";

export function compactProviderText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function truncateProviderText(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	const bounded = value.slice(0, maximum);
	const separator = bounded.lastIndexOf(" ");
	return (separator >= Math.floor(maximum * 0.6) ? bounded.slice(0, separator) : bounded).trim();
}

/** Normalize an HTTP(S) URL whose hostname is a public DNS domain. */
export function normalizePublicDomainHttpUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		const hostname = normalizeDomain(url.hostname);
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !hostname) return undefined;
		url.hostname = hostname;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Normalize an observed URL and bind it to the domain target that owns it. */
export function normalizeObservedUrlForDomain(value: string, target: string): string | undefined {
	const normalizedTarget = normalizeDomain(target);
	const observedUrl = normalizePublicDomainHttpUrl(value);
	if (!normalizedTarget || !observedUrl || !domainMatchesOrIsSubdomain(new URL(observedUrl).hostname, normalizedTarget)) return undefined;
	return observedUrl;
}

function conciseProviderUrl(value: string): string {
	if (value.length <= 320) return value;
	return new URL(value).origin + "/";
}

/**
 * Produce a deterministic provider-sized narrative without trusting an
 * already-rendered draft. The legal-brand URL is validated independently so
 * providers never receive a malformed or credential-bearing URL.
 */
export function makeProviderExplanation(params: {
	description: string;
	legalBrandUrl?: string;
	maximumLength: number;
	legalBrandLabel?: string;
}): string | undefined {
	if (!Number.isSafeInteger(params.maximumLength) || params.maximumLength < 1) return undefined;
	const description = compactProviderText(params.description);
	if (!description) return undefined;

	const legalBrandUrl = params.legalBrandUrl === undefined
		? undefined
		: normalizePublicDomainHttpUrl(params.legalBrandUrl);
	if (params.legalBrandUrl !== undefined && !legalBrandUrl) return undefined;
	if (!legalBrandUrl) return truncateProviderText(description, params.maximumLength);

	const legalBrandLabel = compactProviderText(params.legalBrandLabel ?? "Impersonated brand");
	if (!legalBrandLabel) return undefined;
	const brandLine = "\n" + legalBrandLabel + ": " + conciseProviderUrl(legalBrandUrl);
	if (brandLine.length >= params.maximumLength) return truncateProviderText(brandLine.trim(), params.maximumLength);
	const descriptionBudget = params.maximumLength - brandLine.length;
	return (truncateProviderText(description, descriptionBudget) + brandLine).trim();
}
