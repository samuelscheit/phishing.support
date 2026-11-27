import type { AbuseTargetType } from "../abuse/schema";
import type { Organisation } from "./organisation";

/**
 * The part a provider plays for a reported site, which decides what it can do
 * about it and so what it is measured on:
 *
 * - `registrar`: suspends or deletes the domain.
 * - `host`: removes the content or the server.
 * - `cdn`: proxies the site; it can show a warning and name the real host, not remove it.
 * - `blocklist`: warns browsers and mail filters (Netcraft, Safe Browsing); it removes nothing itself.
 * - `email`: the mail service a phishing message was sent through.
 * - `platform`: a service whose account the scam uses (a chat bot, a webhook).
 * - `authority`: police and prosecutors receiving a criminal complaint, and
 *   the oversight an escalation reaches (CERTs, brands, DSA notices).
 * - `other`: a contact whose part is unknown.
 */
export const providerRoles = ["registrar", "host", "cdn", "blocklist", "email", "platform", "authority", "other"] as const;
export type ProviderRole = (typeof providerRoles)[number];

/** Where the resolver found the contact, by `resolverProvenance.source`. */
const ROLE_BY_SOURCE: Readonly<Record<string, ProviderRole>> = {
	registrar_rdap: "registrar",
	domain_rdap: "registrar",
	domain_whois: "registrar",
	domain_infrastructure_ip: "host",
	ip_rdap: "host",
	ip_whois: "host",
	asn_rdap: "host",
	// The origin server Cloudflare disclosed behind a proxied site.
	cloudflare_origin_disclosure: "host",
	service_account_registry: "platform",
	// The merchant or affiliate network of a deceptive funnel (abuse/funnel), and the vendor of its tracking platform.
	funnel_security_txt: "platform",
	funnel_website: "platform",
	funnel_holder_rdap: "platform",
	funnel_holder_whois: "platform",
	funnel_platform_vendor: "platform",
	authority_registry: "authority",
	// A CERT, a brand or a host notified under the DSA by an escalation the operator approved: oversight, not a provider's own report.
	escalation_oversight: "authority",
	campaign_takedown_reports: "authority",
};

/**
 * The route's role. A blocklist is one whatever led to it; otherwise the
 * resolver's provenance says it, and a hosting route of a company that is a
 * CDN reached its proxy, not the real host. Routes without provenance fall
 * back to the target (a mail target reaches a mail service, an address its
 * network) and then to the company's known role.
 */
export function roleOf(
	route: { providerRegistryKey: string; resolverProvenance: Record<string, unknown> },
	targetType: AbuseTargetType,
	organisation: Organisation,
): ProviderRole {
	if (organisation.role === "blocklist") return "blocklist";
	if (route.providerRegistryKey.startsWith("authority:")) return "authority";
	const source = typeof route.resolverProvenance.source === "string" ? route.resolverProvenance.source : undefined;
	const bySource = source ? ROLE_BY_SOURCE[source] : undefined;
	if (source === "domain_infrastructure_ip" && organisation.role === "cdn") return "cdn";
	if (bySource) return bySource;
	if (targetType === "email") return "email";
	if (targetType === "service_account") return "platform";
	if (targetType === "campaign") return "authority";
	if (targetType === "ip") return "host";
	return organisation.role ?? "other";
}
