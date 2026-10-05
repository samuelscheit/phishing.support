import { CLOUDFLARE_PROVIDER } from "./definition";
import type { CloudflareServiceIdentity } from "./identity";
import { buildProviderReportNarrative, normalizeObservedUrlForDomain, normalizePublicDomainHttpUrl } from "../report_payload";
import type { ProviderReportPreviewContext } from "../submission_contracts";

export type CloudflareFormInput = {
	serviceIdentity: CloudflareServiceIdentity;
	target: string;
	observedUrl: string;
	description: string;
	legalBrandUrl?: string;
};

export type CloudflareFormPayload = {
	name: string;
	email: string;
	emailConfirmation: string;
	company: string;
	urls: string;
	justification: string;
	originalWork: string;
	reportedCountry: string;
	dsaAttestation: true;
	dsaCertification: true;
};

/** Render Cloudflare's read-only report preview without touching its form. */
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
 * Create Cloudflare's reviewed form payload from the standalone report. The
 * allegation narrative is intentionally part of `justification`; the old
 * website reporter generated this evidence but discarded it before submit.
 */
export function buildCloudflareFormPayload(input: CloudflareFormInput): CloudflareFormPayload {
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
		emailConfirmation: input.serviceIdentity.mailbox,
		company: input.serviceIdentity.organizationUrl,
		urls: observedUrl,
		justification,
		originalWork: legalBrandUrl ?? "Not identified",
		reportedCountry: input.serviceIdentity.reportedCountry,
		dsaAttestation: true,
		dsaCertification: true,
	};
}
