import { registrableDomain } from "../abuse/security";
import type { ProviderRole } from "./role";

/**
 * The company a provider route reaches, whatever channel it used: its page
 * address, its name, and for known companies the part they play when a route
 * does not say (routes without resolver provenance).
 */
export type Organisation = { slug: string; name: string; role?: ProviderRole };

/**
 * Companies reached through more than one channel or mailbox domain, keyed by
 * provider registry key or by the registrable
 * domain of the abuse mailbox. Anything not listed is its own organisation,
 * named after its mailbox domain.
 */
const KNOWN: ReadonlyArray<Organisation & { role: ProviderRole; providerKeys?: readonly string[]; mailDomains?: readonly string[] }> = [
	{ slug: "cloudflare", name: "Cloudflare", role: "cdn", providerKeys: ["cloudflare", "cloudflare_abuse"], mailDomains: ["cloudflare.com"] },
	{ slug: "netcraft", name: "Netcraft", role: "blocklist", providerKeys: ["netcraft", "netcraft_mail"], mailDomains: ["netcraft.com"] },
	{ slug: "google-safe-browsing", name: "Google Safe Browsing", role: "blocklist", providerKeys: ["google_safe_browsing"] },
	{ slug: "google", name: "Google", role: "host", providerKeys: ["google_cloud"], mailDomains: ["google.com"] },
	{ slug: "amazon", name: "Amazon", role: "host", mailDomains: ["amazon.com", "aws.com", "amazonaws.com"] },
	{ slug: "alibaba-cloud", name: "Alibaba Cloud", role: "host", mailDomains: ["aliyun.com", "alibaba-inc.com", "alibabacloud.com"] },
	{ slug: "tencent-cloud", name: "Tencent Cloud", role: "host", providerKeys: ["tencent"], mailDomains: ["tencent.com"] },
	{ slug: "microsoft", name: "Microsoft", role: "host", mailDomains: ["microsoft.com", "azure.com"] },
	{ slug: "discord", name: "Discord", role: "platform", providerKeys: ["discord_dsa", "discord_webhook"], mailDomains: ["discord.com"] },
	{ slug: "gname", name: "Gname", role: "registrar", providerKeys: ["gname"], mailDomains: ["gname.com"] },
	{ slug: "namesilo", name: "NameSilo", role: "registrar", providerKeys: ["namesilo"], mailDomains: ["namesilo.com"] },
	{ slug: "eranet", name: "Eranet", role: "registrar", providerKeys: ["eranet"], mailDomains: ["eranet.com"] },
	{ slug: "namecheap", name: "Namecheap", role: "registrar", mailDomains: ["namecheap.com", "namecheaphosting.com"] },
	{ slug: "newfold-digital", name: "Newfold Digital", role: "host", mailDomains: ["newfold.com", "bluehost.com", "hostgator.com", "web.com", "networksolutions.com"] },
	{ slug: "tucows", name: "Tucows", role: "registrar", mailDomains: ["tucows.com", "enom.com"] },
	{ slug: "ovhcloud", name: "OVHcloud", role: "host", mailDomains: ["ovh.net", "ovh.ca", "ovh.com", "ovhcloud.com"] },
	{ slug: "godaddy", name: "GoDaddy", role: "registrar", mailDomains: ["godaddy.com", "secureserver.net"] },
	{ slug: "hostinger", name: "Hostinger", role: "host", mailDomains: ["hostinger.com"] },
	{ slug: "render", name: "Render", role: "host", mailDomains: ["render.com"] },
	{ slug: "vercel", name: "Vercel", role: "host", mailDomains: ["vercel.com"] },
	{ slug: "github", name: "GitHub", role: "host", mailDomains: ["github.com"] },
	{ slug: "publicdomainregistry", name: "PublicDomainRegistry", role: "registrar", mailDomains: ["publicdomainregistry.com"] },
	{ slug: "markmonitor", name: "MarkMonitor", role: "registrar", mailDomains: ["markmonitor.com"] },
	{ slug: "spaceship", name: "Spaceship", role: "registrar", mailDomains: ["spaceship.com"] },
	{ slug: "dynadot", name: "Dynadot", role: "registrar", mailDomains: ["dynadot.com"] },
	{ slug: "contabo", name: "Contabo", role: "host", mailDomains: ["contabo.de", "contabo.com"] },
	{ slug: "key-systems", name: "Key-Systems", role: "registrar", mailDomains: ["key-systems.net"] },
	// Hosting Concepts B.V. trades as Registrar.eu and answers from Openprovider's desk.
	{ slug: "openprovider", name: "Openprovider", role: "registrar", mailDomains: ["registrar.eu", "openprovider.nl", "openprovider.com"] },
	{ slug: "realtime-register", name: "Realtime Register", role: "registrar", mailDomains: ["realtimeregister.com"] },
	{ slug: "ionos", name: "IONOS", role: "host", mailDomains: ["ionos.com", "ionos.de", "1and1.com"] },
	{ slug: "twilio-sendgrid", name: "Twilio SendGrid", role: "email", mailDomains: ["sendgrid.com", "twilio.com"] },
	{ slug: "bunny-net", name: "bunny.net", role: "cdn", mailDomains: ["bunnycdn.com", "bunny.net"] },
	{ slug: "cogent", name: "Cogent", role: "host", mailDomains: ["cogentco.com"] },
];

/**
 * Mailbox domains anyone can have an address at. A registrant or small
 * provider whose abuse contact is a Gmail address is not Google: the mailbox
 * itself names the organisation.
 */
const FREE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "qq.com", "163.com", "126.com", "proton.me", "protonmail.com", "gmx.de", "gmx.net", "mail.ru", "yandex.ru", "icloud.com"]);

const byProviderKey = new Map(KNOWN.flatMap((organisation) => (organisation.providerKeys ?? []).map((key) => [key, organisation] as const)));
const byMailDomain = new Map(KNOWN.flatMap((organisation) => (organisation.mailDomains ?? []).map((domain) => [domain, organisation] as const)));

/** A page address from any name: lower case, words joined by hyphens. */
export function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * The organisation behind a provider route. Mail routes are grouped by their
 * mailbox's registrable domain, because their display names are mostly
 * generic RDAP role names ("Abuse-C Role", "Abuse team"); provider
 * integrations by their registry key. Authorities are each their own.
 */
export function organisationOf(route: { providerRegistryKey: string; providerDisplayName: string; verifiedEmail: string | null }): Organisation {
	const key = route.providerRegistryKey;
	if (key.startsWith("authority:")) return { slug: slugify(key), name: route.providerDisplayName };
	const known = byProviderKey.get(key);
	if (known) return { slug: known.slug, name: known.name, role: known.role };
	const email = route.verifiedEmail?.trim().toLowerCase() || undefined;
	const mailDomain = email?.slice(email.lastIndexOf("@") + 1) ?? (key.startsWith("email:") ? key.slice("email:".length).toLowerCase() : undefined);
	if (!mailDomain) return { slug: slugify(key), name: route.providerDisplayName };
	if (FREE_MAIL_DOMAINS.has(mailDomain) && email) return { slug: slugify(email), name: email };
	const domain = registrableDomain(mailDomain) ?? mailDomain;
	const knownDomain = byMailDomain.get(domain);
	if (knownDomain) return { slug: knownDomain.slug, name: knownDomain.name, role: knownDomain.role };
	return { slug: slugify(domain), name: domain };
}
