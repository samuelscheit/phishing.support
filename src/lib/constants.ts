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

/**
 * The headers of a page request from that desktop browser, for plain HTTP
 * visits to a reported site: a kit answers a client without them with a
 * decoy or nothing.
 */
export const browserRequestHeaders: Readonly<Record<string, string>> = {
	"user-agent": userAgent,
	accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"accept-language": "en-US,en;q=0.9",
};
