import { CLOUDFLARE_PROVIDER } from "./definition";
import type { CloudflareServiceIdentity } from "./identity";
import { buildProviderReportNarrative, normalizeObservedUrlForDomain, normalizePublicDomainHttpUrl } from "../report_payload";
import type { ProviderReportPreviewContext } from "../submission_contracts";

export type CloudflareReportInput = {
	serviceIdentity: CloudflareServiceIdentity;
	target: string;
	observedUrl: string;
	description: string;
	legalBrandUrl?: string;
};

export type CloudflareReportPayload = {
	name: string;
	email: string;
	company: string;
	urls: string;
	justification: string;
	originalWork?: string;
	reportedCountry: string;
};

/** Render Cloudflare's read-only report preview without calling its API. */
export function buildCloudflareReportPreview(input: ProviderReportPreviewContext): string | undefined {
	return buildProviderReportNarrative({
		provider: "cloudflare",
		target: input.target,
		observedUrls: input.observedUrls,
		description: input.description,
		...(input.legalBrandUrl ? { legalBrandUrl: input.legalBrandUrl } : {}),
		maximumLength: CLOUDFLARE_PROVIDER.maximumJustificationLength,
	});
}

/**
 * Create Cloudflare's reviewed report payload from the standalone report. The
 * allegation narrative is intentionally part of `justification`.
 */
export function buildCloudflareReportPayload(input: CloudflareReportInput): CloudflareReportPayload {
	const observedUrl = normalizeObservedUrlForDomain(input.observedUrl, input.target);
	if (!observedUrl) throw new Error("Cloudflare abuse reporting requires a valid observed URL for the target.");
	const legalBrandUrl = input.legalBrandUrl === undefined ? undefined : normalizePublicDomainHttpUrl(input.legalBrandUrl);
	if (input.legalBrandUrl !== undefined && !legalBrandUrl) throw new Error("Cloudflare abuse reporting requires a valid legal brand URL.");
	const description = buildCloudflareReportPreview({
		target: input.target,
		observedUrls: [observedUrl],
		description: input.description,
	});
	if (!description) throw new Error("Cloudflare abuse reporting requires a non-empty report description.");
	const prefix = [
		`Phishing report for ${input.target}.`,
		`Observed URL: ${observedUrl}`,
		legalBrandUrl ? `Legitimate brand URL: ${legalBrandUrl}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
	const available = Math.max(0, CLOUDFLARE_PROVIDER.maximumJustificationLength - prefix.length - 2);
	const justification = `${prefix}\n\n${description.slice(0, available)}`.slice(0, CLOUDFLARE_PROVIDER.maximumJustificationLength);

	return {
		name: input.serviceIdentity.name,
		email: input.serviceIdentity.mailbox,
		company: input.serviceIdentity.organizationUrl,
		urls: observedUrl,
		justification,
		...(legalBrandUrl ? { originalWork: legalBrandUrl } : {}),
		reportedCountry: input.serviceIdentity.reportedCountry,
	};
}
