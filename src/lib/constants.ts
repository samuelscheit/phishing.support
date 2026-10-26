/**
 * The identity every provider sees for a report this service files: Netcraft,
 * Cloudflare, Tencent, and abuse mailboxes. A public submitter is only named
 * in the report text, never as the provider-facing reporter.
 */
export const serviceIdentity = {
	name: "Phishing Support",
	mailbox: "support@phishing.support",
	url: "https://phishing.support",
	countryCode: "DE",
	countryName: "Germany",
} as const;

export const userAgent =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
