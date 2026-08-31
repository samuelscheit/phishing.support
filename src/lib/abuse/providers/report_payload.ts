import { domainMatchesOrIsSubdomain, normalizeDomain } from "../security";

export function compactProviderText(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
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
 * The legacy website analyser stores a deliberately detailed model answer in
 * `abuse_reports.description`. That field is useful for auditability, but it
 * is not a provider submission draft: it can contain Markdown, citations,
 * stale conclusions, and instructions written by an untrusted page. Direct
 * providers therefore receive a code-owned narrative assembled from a small
 * set of detected indicators rather than a slice of the model answer.
 */
export type ProviderReportProfile =
	| "generic"
	| "cloudflare"
	| "google_safe_browsing"
	| "netcraft"
	| "tencent"
	| "gname";

type ProviderReportNarrativeInput = {
	provider?: ProviderReportProfile;
	target?: string;
	observedUrls?: readonly string[];
	description: string;
	legalBrandUrl?: string;
	legalBrandLabel?: string;
	maximumLength: number;
};

type EvidenceIndicator = {
	label: string;
	pattern: RegExp;
};

const EVIDENCE_INDICATORS: readonly EvidenceIndicator[] = [
	{ label: "brand impersonation", pattern: /\b(?:impersonat\w*|spoof\w*|lookalike\w*|clone\w*|fake\s+(?:brand|site|service)|copied\s+(?:brand|wording)|logo)\b/i },
	{ label: "a login or credential-collection flow", pattern: /\b(?:credential\w*|password\w*|passcode\w*|login\w*|log[ -]?in\w*|sign[ -]?in\w*|username\w*|account\s+(?:access|verification)|harvest\w*)\b/i },
	{ label: "a payment or financial-data request", pattern: /\b(?:payment\w*|pay(?:ment)?\w*|credit\s*card|debit\s*card|card\s*(?:number|details)|billing\w*|wallet\w*|bank\w*|fee\w*|coin(?:s)?\w*|recharge\w*)\b/i },
	{ label: "a data-collection form", pattern: /\b(?:collect\w*|capture\w*|submit\w*|submission\w*|form\w*|input\w*|personal\s+information|data\s+collection)\b/i },
	{ label: "suspicious redirects or malicious content", pattern: /\b(?:redirect\w*|malware\w*|malicious\w*|payload\w*|download\w*|exploit\w*|script\s+injection)\b/i },
	{ label: "a newly registered or recently created domain", pattern: /\b(?:newly\s+registered|recently\s+(?:registered|created)|registration\s+(?:date|record)|new\s+domain)\b/i },
];

const BRAND_PATTERNS: readonly RegExp[] = [
	/\b(?:likely\s+)?impersonated\s+brand\s*:\s*(?:\*\*)?([^*\n|]{1,100})/i,
	/\btarget\s+brand\s*:\s*(?:\*\*)?([^*\n|]{1,100})/i,
	/\bbrand\s+impersonated\s*:\s*(?:\*\*)?([^*\n|]{1,100})/i,
	/\b(?:appears?|seems?)\s+to\s+impersonat(?:e|es|ing|ed)\s+(?:the\s+)?(?:\*\*)?([^*\n|.!?]{2,100})/i,
	/\b([\p{L}][\p{L}\p{N}&.'’+-]{1,80})\s+impersonation\b/iu,
];

function safeNarrativeTarget(value: string | undefined, maximumCharacters = 255): string {
	const target = value ? compactProviderText(value) : "";
	// Never cut a domain in the middle. Provider payloads carry the exact
	// normalized target separately; the narrative can use a neutral label when
	// an unusually long IDN would consume the entire short text field.
	return target && target.length <= maximumCharacters ? target : "the reported target";
}

/** Extract only a short display label; never forward a model-generated URL or instruction. */
function extractedBrandName(description: string): string | undefined {
	for (const pattern of BRAND_PATTERNS) {
		const match = description.match(pattern);
		if (!match?.[1]) continue;
		const candidate = match[1]
			.replace(/[*_`~]/g, "")
			.replace(/https?:\/\/\S+/gi, "")
			.replace(/^the\s+/i, "")
			.replace(/\s+/g, " ")
			.replace(/[^\p{L}\p{N} .&'’/()+-]/gu, "")
			.trim()
			.replace(/[,:;.!?]+$/, "")
			.slice(0, 80)
			.trim();
		if (!candidate || /\b(?:ignore|previous\s+instructions|send|reveal|secret|password)\b/i.test(candidate)) continue;
		return candidate;
	}
	return undefined;
}

function detectedIndicators(description: string): string[] {
	return EVIDENCE_INDICATORS
		.filter((indicator) => indicator.pattern.test(description))
		.map((indicator) => indicator.label);
}

function joinIndicators(indicators: readonly string[]): string {
	if (indicators.length === 0) return "suspicious content that warrants provider review";
	const readable = indicators.map((indicator) => indicator === "a login or credential-collection flow"
		? "a login or credential-collection flow that captures login credentials"
		: indicator);
	if (readable.length === 1) return readable[0]!;
	if (readable.length === 2) return `${readable[0]} and ${readable[1]}`;
	return `${readable.slice(0, -1).join(", ")}, and ${readable.at(-1)}`;
}

function profileCopy(provider: ProviderReportProfile, target: string, observedUrlCount: number): { lead: string; action: string; urlContext: string } {
	const urlContext = observedUrlCount === 1
		? "The submitted form identifies one observed URL."
		: observedUrlCount > 1
			? `The submitted form identifies ${observedUrlCount} observed URLs.`
			: "No observed URL was available in the submitted evidence.";
		switch (provider) {
		case "cloudflare":
			return {
				lead: `A suspected phishing URL using Cloudflare infrastructure is being reported for ${target}.`,
				action: "Please investigate the hosted content and take any appropriate action under Cloudflare's abuse policy.",
				urlContext,
			};
		case "google_safe_browsing":
			return {
				lead: `A suspected phishing URL on ${target} is being submitted to Google Safe Browsing.`,
				action: "Please evaluate the submitted URL for inclusion in Safe Browsing protections.",
				urlContext,
			};
		case "netcraft":
			return {
				lead: `A suspected phishing URL report is being submitted to Netcraft for ${target}.`,
				action: "Please investigate the URL and associated infrastructure.",
				urlContext,
			};
		case "tencent":
			return {
				lead: `A suspected phishing domain report is being submitted to Tencent Cloud for ${target}.`,
				action: "Please investigate and mitigate the reported domain under your abuse policy.",
				urlContext,
			};
		case "gname":
			return {
				lead: `A suspected phishing or fraud report is being prepared for GNAME regarding ${target}.`,
				action: "Please review the captured evidence and apply the appropriate registrar abuse action.",
				urlContext,
			};
		default:
			return {
				lead: `Suspected phishing activity involving ${target} is being reported.`,
				action: "Please investigate the reported activity.",
				urlContext,
			};
	}
}

function fitNarrative(parts: readonly string[], maximumLength: number): string {
	const full = parts.filter(Boolean).join(" ").trim();
	if (full.length <= maximumLength) return full;

	// Keep complete sentences only. Truncating the middle of an allegation can
	// turn "Impersonated brand:" into an unsupported dangling assertion or
	// leave a provider form with a grammatically broken reason. Prefer the
	// provider identity, evidence, and requested action; add URL/reference
	// context only when the whole sentence still fits.
	const lead = parts[0] ?? "Suspected phishing activity is being reported.";
	const urlContext = parts[1] ?? "";
	const facts = parts[2] ?? "";
	const reference = parts[3] ?? "";
	const action = parts.at(-1) ?? "Please investigate the reported activity.";
	const selected = [lead];
	if ([lead, action].filter(Boolean).join(" ").length > maximumLength) {
		return truncateProviderText([lead, action].filter(Boolean).join(" "), maximumLength);
	}
	for (const candidate of [facts, urlContext, reference]) {
		if (!candidate) continue;
		if ([...selected, candidate, action].filter(Boolean).join(" ").length <= maximumLength) selected.push(candidate);
	}
	return [...selected, action].filter(Boolean).join(" ");
}

/**
 * Build a provider-specific report narrative from structured indicators. The
 * full analysis remains available in the Analysis tab, but is never pasted
 * into a direct provider's free-text field.
 */
export function buildProviderReportNarrative(params: ProviderReportNarrativeInput): string | undefined {
	if (!Number.isSafeInteger(params.maximumLength) || params.maximumLength < 1) return undefined;
	const description = compactProviderText(params.description);
	if (!description) return undefined;

	const legalBrandUrl = params.legalBrandUrl === undefined
		? undefined
		: normalizePublicDomainHttpUrl(params.legalBrandUrl);
	if (params.legalBrandUrl !== undefined && !legalBrandUrl) return undefined;

	const provider = params.provider ?? "generic";
	const target = safeNarrativeTarget(params.target, params.maximumLength <= 500 ? 240 : 255);
	const copy = profileCopy(provider, target, params.observedUrls?.length ?? 0);
	const brand = extractedBrandName(description);
	// Small provider fields should never end halfway through an allegation.
	// Keep the two strongest evidence categories rather than truncating a
	// longer, grammatically incomplete analysis sentence.
	const indicators = detectedIndicators(description);
	const selectedIndicators = params.maximumLength <= 500 ? indicators.slice(0, 2) : indicators;
	const facts = brand
		? `The captured page appears to impersonate ${brand} and contains ${joinIndicators(selectedIndicators)}.`
		: `The captured evidence indicates ${joinIndicators(selectedIndicators)}.`;
	const referenceLabel = compactProviderText(params.legalBrandLabel ?? "Impersonated brand") || "Impersonated brand";
	const reference = legalBrandUrl ? `${referenceLabel}: ${conciseProviderUrl(legalBrandUrl)}.` : "";

	return fitNarrative([copy.lead, copy.urlContext, facts, reference, copy.action], params.maximumLength);
}
