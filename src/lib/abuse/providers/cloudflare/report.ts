import { CLOUDFLARE_PROVIDER } from "./definition";
import { serviceIdentity } from "../../../constants";
import { normalizePublicHttpUrl } from "../../security";
import { allegationLabel, boundedEvidence, normalizeObservedUrlForTarget } from "../report_payload";
import type { ProviderReportPreviewContext } from "../submission_contracts";

export type CloudflareReportInput = {
	/** The submitter's country when known; the service's own country otherwise. */
	reportedCountry?: string | null;
	target: string;
	observedUrl: string;
	description: string;
	/** `phishing` or `malware`: Cloudflare's phishing report type is its "Phishing & Malware" form. */
	allegationCategory?: string;
	legalBrandUrl?: string;
	/** The User-Agent Cloudflare's reviewer must send to see the content. */
	reportedUserAgent?: string;
};

export type CloudflareReportPayload = {
	name: string;
	email: string;
	company: string;
	urls: string;
	justification: string;
	originalWork?: string;
	reportedCountry: string;
	reportedUserAgent?: string;
};

/**
 * One builder serves both the reviewed preview and the form payload, so the
 * operator approves exactly what Cloudflare receives. The target, observed URL
 * and legal brand URL are never truncated; only the evidence body is bounded.
 */
function buildCloudflareJustification(input: { target: string; observedUrl: string; legalBrandUrl?: string; description: string; allegationCategory?: string }): string | undefined {
	const allegation = allegationLabel(input.allegationCategory);
	const evidenceLabel = `Why this is ${allegation}:`;
	const prefix = [
		`Confirmed ${allegation} site: ${input.target}`,
		`${allegation === "phishing" ? "Phishing" : "Malware distribution"} URL: ${input.observedUrl}`,
		input.legalBrandUrl ? `Impersonated brand's real site: ${input.legalBrandUrl}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
	const evidence = boundedEvidence(input.description, CLOUDFLARE_PROVIDER.maximumJustificationLength - prefix.length - evidenceLabel.length - 3);
	return evidence ? `${prefix}\n\n${evidenceLabel}\n${evidence}` : undefined;
}

/** Render the exact justification the Cloudflare form will receive. */
export function buildCloudflareReportPreview(input: ProviderReportPreviewContext): string | undefined {
	const observedUrl = input.observedUrls.map((url) => normalizeObservedUrlForTarget(url, input.target)).find(Boolean);
	if (!observedUrl) return undefined;
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	if (input.legalBrandUrl && !legalBrandUrl) return undefined;
	return buildCloudflareJustification({ target: input.target, observedUrl, ...(legalBrandUrl ? { legalBrandUrl } : {}), description: input.description, ...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}) });
}

/** Create Cloudflare's reviewed form payload from the abuse report. */
export function buildCloudflareReportPayload(input: CloudflareReportInput): CloudflareReportPayload {
	const observedUrl = normalizeObservedUrlForTarget(input.observedUrl, input.target);
	if (!observedUrl) throw new Error("Cloudflare abuse reporting requires a valid observed URL for the target.");
	const legalBrandUrl = input.legalBrandUrl === undefined ? undefined : normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true });
	if (input.legalBrandUrl !== undefined && !legalBrandUrl) throw new Error("Cloudflare abuse reporting requires a valid legal brand URL.");
	const justification = buildCloudflareJustification({ target: input.target, observedUrl, ...(legalBrandUrl ? { legalBrandUrl } : {}), description: input.description, ...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}) });
	if (!justification) throw new Error("Cloudflare abuse reporting requires a non-empty report description.");

	return {
		name: serviceIdentity.name,
		email: serviceIdentity.mailbox,
		company: `${serviceIdentity.url}/`,
		urls: observedUrl,
		justification,
		...(legalBrandUrl ? { originalWork: legalBrandUrl } : {}),
		reportedCountry: /^[A-Z]{2}$/.test(input.reportedCountry ?? "") ? input.reportedCountry! : serviceIdentity.countryCode,
		...(input.reportedUserAgent ? { reportedUserAgent: input.reportedUserAgent.slice(0, 255) } : {}),
	};
}
