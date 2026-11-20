import { normalizePublicHttpUrl } from "../../security";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget, truncateProviderText, type ProviderReportProfile } from "../report_payload";
import type { ReportInput } from "./draft";

/** A provider's answer, flattened to one short line for an error message. */
export function snippet(text: string, maximum = 300): string {
	return text.replace(/\s+/g, " ").trim().slice(0, maximum);
}

/** The visible text of an HTML answer, as a snippet. */
export function htmlText(html: string, maximum = 300): string {
	return snippet(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "), maximum);
}

export type UrlRules = {
	/** Longest URL a form field or the stored draft takes; shorter than `minimumLength` is no URL. */
	maximumLength: number;
	minimumLength?: number;
	/** What a URL may not contain (default: whitespace). */
	forbidden?: RegExp;
	/** Most URLs listed. */
	maximum?: number;
	/** Characters a URL block may use in total; each URL also costs its newline and "- " (3). */
	budget?: number;
	/** Whether the host's root page stands in when no observed URL fits (not for a bare IP nobody saw serve a page). */
	rootFallback?: boolean;
};

/** A URL as the builders write it: public, normalised, without whitespace (a form splitting on whitespace would make two), within the length rules. */
export function isReportUrl(value: unknown, { maximumLength, minimumLength = 1, forbidden = /\s/ }: Pick<UrlRules, "maximumLength" | "minimumLength" | "forbidden">): value is string {
	return typeof value === "string" && value.length >= minimumLength && value.length <= maximumLength && !forbidden.test(value) && normalizePublicHttpUrl(value) === value;
}

/** The observed URLs that belong to the target, in order, deduplicated and within the rules; the host's root when none fits. */
export function reportUrls(host: string, observedUrls: readonly string[], rules: UrlRules): string[] {
	const urls: string[] = [];
	let length = 0;
	for (const value of observedUrls) {
		const url = normalizeObservedUrlForTarget(value, host);
		if (!url || !isReportUrl(url, rules) || urls.includes(url)) continue;
		if (urls.length >= (rules.maximum ?? Number.POSITIVE_INFINITY) || (rules.budget !== undefined && length + url.length + 3 > rules.budget)) continue;
		urls.push(url);
		length += url.length + 3;
	}
	if (urls.length > 0 || rules.rootFallback === false) return urls;
	const root = normalizePublicHttpUrl(`https://${host.includes(":") ? `[${host}]` : host}/`);
	return root && isReportUrl(root, rules) ? [root] : [];
}

/** The `Reported URLs` block of a free-text field. */
export const urlBlock = (urls: readonly string[]) => `Reported URLs:\n${urls.map((url) => `- ${url}`).join("\n")}`;

export type NarrativeInput = Pick<ReportInput, "target" | "description" | "allegationCategory" | "legalBrandUrl"> & {
	observedUrls: readonly string[];
	/** What the evidence is: a captured page (default) or an email. */
	source?: "page" | "email";
};

/** The code-owned narrative for a provider. A brand URL that does not normalise is left out, not an error. */
export function providerNarrative(provider: ProviderReportProfile, input: NarrativeInput, maximumLength: number): string | undefined {
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	return buildProviderReportNarrative({
		provider,
		target: input.target,
		observedUrls: input.observedUrls,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		...(input.source ? { source: input.source } : {}),
		maximumLength,
	});
}

/**
 * One free-text field: `before` parts, the narrative, then the hosting line
 * and the case page, within `limit`. The narrative either gets what the other
 * parts leave (`minimum`: below it the report is not drafted) or a fixed
 * `maximum`. The reference leads so the provider's mail quotes it.
 */
export function composeFreeText(params: {
	provider: ProviderReportProfile;
	input: NarrativeInput & Pick<ReportInput, "hostingLine" | "caseUrl">;
	urls: readonly string[];
	limit: number;
	before: readonly string[];
	hostingLimit: number;
	narrative: { minimum: number } | { maximum: number };
}): string | undefined {
	const { input } = params;
	const after = [
		input.hostingLine ? truncateProviderText(input.hostingLine, params.hostingLimit) : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part);
	let maximum: number;
	if ("maximum" in params.narrative) maximum = params.narrative.maximum;
	else {
		maximum = params.limit - [...params.before, ...after].reduce((sum, part) => sum + part.length, 0) - 2 * (params.before.length + after.length + 1);
		if (maximum < params.narrative.minimum) return undefined;
	}
	const narrative = providerNarrative(params.provider, { ...input, observedUrls: params.urls }, maximum);
	if (!narrative) return undefined;
	const text = [...params.before, narrative, ...after].join("\n\n");
	return text.length <= params.limit ? text : undefined;
}

/**
 * The free-text field of a registrar form that lists the reported URLs before
 * the narrative: `urls` picks them for a domain, `make` writes the field. The
 * limits are the definition's (`urlsMaximumLength`, `maximumUrls`,
 * `hostingLineMaximumLength`, `narrativeMinimumLength`) beside the field's own.
 */
export function listedFreeText(
	provider: ProviderReportProfile,
	definition: { urlsMaximumLength: number; maximumUrls: number; hostingLineMaximumLength: number; narrativeMinimumLength: number },
	field: { limit: number; urlMaximumLength: number },
) {
	const rules: UrlRules = { maximumLength: field.urlMaximumLength, maximum: definition.maximumUrls, budget: definition.urlsMaximumLength };
	return {
		urls: (domain: string, observedUrls: readonly string[]) => reportUrls(domain, observedUrls, rules),
		make: (input: NarrativeInput & Pick<ReportInput, "trackingId" | "hostingLine" | "caseUrl">, urls: readonly string[]) => composeFreeText({
			provider,
			input,
			urls,
			limit: field.limit,
			before: [`Reference: ${input.trackingId}`, urlBlock(urls)],
			hostingLimit: definition.hostingLineMaximumLength,
			narrative: { minimum: definition.narrativeMinimumLength },
		}),
		/** A stored URL: what `urls` could have listed. */
		isUrl: (value: unknown): value is string => isReportUrl(value, rules),
		rules,
	};
}
