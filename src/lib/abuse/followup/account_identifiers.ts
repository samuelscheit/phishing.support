/** An identifier in a kit's own pages that ties it to an account at a provider, e.g. a Cloudflare Turnstile sitekey. */
export type ProviderAccountIdentifier = { kind: string; label: string; value: string };

/** Finds a provider's account identifiers in a captured page's HTML. */
export type AccountIdentifierExtractor = (html: string) => ProviderAccountIdentifier[];

/**
 * Cloudflare Turnstile sitekeys. Every widget a kit embeds names the
 * Cloudflare account that created it, so the key outlives the domain the kit
 * was on. Cloudflare's published test keys (`1x…`, `2x…`, `3x…`) never match.
 */
export const extractTurnstileSitekeys: AccountIdentifierExtractor = (html) => [...new Set(html.match(/\b0x4AAAAAA[A-Za-z0-9_-]{10,40}\b/g) ?? [])]
	.map((value) => ({ kind: "cloudflare_turnstile_sitekey", label: "Cloudflare Turnstile sitekey", value }));
