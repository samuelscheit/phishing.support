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

/**
 * The User-Agent of a desktop browser, for requests a provider's own web page
 * normally makes (its form, portal or console endpoints, a link it mails):
 * those sit behind gateways and WAFs that deny non-browser clients. AWS's
 * abuse form denies `Bun/…`, `curl`, bare `Mozilla/5.0` and `HeadlessChrome`
 * with 403 (probed 2026-11-22), so it must stay a full, non-headless desktop
 * Chrome UA.
 */
export const browserUserAgent =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/**
 * The honest User-Agent for APIs meant for programs (a provider's keyed or
 * public API, RDAP, RIPEstat, urlscan, …): it names the service and where to
 * reach its operator, instead of the runtime's anonymous `Bun/…`.
 */
export const serviceUserAgent = `${serviceIdentity.name.replace(/\s+/g, "")}/1 (+${serviceIdentity.url})`;

/** Discord's HTTP API requires `DiscordBot ($url, $versionNumber)`, optionally followed by more; requests without a valid UA may be blocked. */
export const discordUserAgent = `DiscordBot (${serviceIdentity.url}, 1) ${serviceUserAgent}`;

/**
 * The headers of a page request from that desktop browser, for plain HTTP
 * visits to a reported site: a kit answers a client without them with a
 * decoy or nothing.
 */
export const browserRequestHeaders: Readonly<Record<string, string>> = {
	"user-agent": browserUserAgent,
	accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"accept-language": "en-US,en;q=0.9",
};
