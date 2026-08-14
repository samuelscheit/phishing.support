import { CLOUDFLARE_PROVIDER } from "./definition";
import type { CloudflareServiceIdentity } from "./identity";

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

function compact(value: string): string {
	return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Create Cloudflare's reviewed form payload from the standalone report. The
 * allegation narrative is intentionally part of `justification`; the old
 * website reporter generated this evidence but discarded it before submit.
 */
export function buildCloudflareFormPayload(input: CloudflareFormInput): CloudflareFormPayload {
	const description = compact(input.description);
	if (!description) throw new Error("Cloudflare abuse reporting requires a non-empty report description.");
	const observedUrl = new URL(input.observedUrl).toString();
	const legalBrandUrl = input.legalBrandUrl ? new URL(input.legalBrandUrl).toString() : undefined;
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
