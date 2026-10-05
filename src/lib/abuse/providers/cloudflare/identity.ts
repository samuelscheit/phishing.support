const DEFAULT_NAME = "Phishing Support";
const DEFAULT_MAILBOX = "support@phishing.support";
const DEFAULT_ORGANIZATION_URL = "https://phishing.support";
const DEFAULT_REPORTED_COUNTRY = "DE";

const MAILBOX_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export type CloudflareServiceIdentity = {
	name: string;
	mailbox: string;
	organizationUrl: string;
	reportedCountry: string;
};

function requiredUrl(name: string, value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid HTTPS URL.`);
	}
	if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${name} must be a valid HTTPS URL.`);
	return url.toString();
}

function countryCode(value: string): string {
	const code = value.trim().toUpperCase();
	if (!/^[A-Z]{2}$/.test(code)) throw new Error("Cloudflare reported country must be a two-letter ISO country code.");
	return code;
}

/** Provider-owned identity; it is validated before the durable external-call marker. */
export function cloudflareServiceIdentity(requesterCountry?: string | null): CloudflareServiceIdentity {
	const name = process.env.ABUSE_CLOUDFLARE_SERVICE_NAME?.trim() || DEFAULT_NAME;
	const mailbox = (process.env.ABUSE_CLOUDFLARE_SERVICE_MAILBOX?.trim() || DEFAULT_MAILBOX).toLowerCase();
	if (!MAILBOX_PATTERN.test(mailbox)) throw new Error("ABUSE_CLOUDFLARE_SERVICE_MAILBOX must be a valid mailbox.");
	const organizationUrl = requiredUrl(
		"ABUSE_CLOUDFLARE_SERVICE_URL",
		process.env.ABUSE_CLOUDFLARE_SERVICE_URL?.trim() || DEFAULT_ORGANIZATION_URL,
	);
	return {
		name,
		mailbox,
		organizationUrl,
		reportedCountry: countryCode(requesterCountry || process.env.ABUSE_CLOUDFLARE_REPORTED_COUNTRY || DEFAULT_REPORTED_COUNTRY),
	};
}
