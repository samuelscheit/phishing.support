import type { Bilingual } from "./countries";

/**
 * What an investigator needs to know about one provider's records: which
 * company holds them (often not the one in the server's country), where it
 * sits, and what the provider itself publishes about access and deletion.
 * The legal instruments follow from the holder's country (countries.ts).
 * Sources: each provider's own page, collected in docs/research/.
 */
export type ProviderLead = {
	/** The company that holds the customer records, as investigators address it. */
	holder: Bilingual;
	/** ISO country of that company. */
	country: string;
	/** Provider-specific facts: what data exists, its contact for authorities, how long it keeps it. */
	facts: Bilingual;
	source?: string;
};

const LEADS: ReadonlyArray<{ pattern: RegExp } & ProviderLead> = [
	{
		pattern: /cloudflare/i,
		holder: { de: "Cloudflare, Inc.", en: "Cloudflare, Inc." },
		country: "US",
		facts: {
			de: "CDN/Proxy, kein Hoster der Inhalte. Hält Kundenkonto, Zahlungsdaten und den Ursprungsserver (Origin) des Kontos; Behördenkontakt lawenforcement@cloudflare.com. Ob Cloudflare einen EU-Adressaten nach der E-Evidence-Verordnung benannt hat, ist nicht geprüft.",
			en: "CDN/proxy, not the host of the content. Holds the account, its payment data and the account's origin server; law-enforcement contact lawenforcement@cloudflare.com. Whether Cloudflare designated an EU addressee under the e-Evidence Regulation is unverified.",
		},
		source: "https://www.cloudflare.com/trust-hub/law-enforcement/",
	},
	{
		// The registrar entity, before the hosting brand below.
		pattern: /hostinger operations/i,
		holder: { de: "HOSTINGER operations, UAB (Registrar)", en: "HOSTINGER operations, UAB (registrar)" },
		country: "LT",
		facts: {
			de: "Registrar; Registrierungsdaten nach ICANN-Vertrag bis 2 Jahre nach Ende der Registrierung.",
			en: "Registrar; under its ICANN contract it keeps registration data up to 2 years after a registration ends.",
		},
		source: "https://www.hostinger.com/legal/abuse-policy",
	},
	{
		pattern: /hostinger/i,
		holder: { de: "Hostinger International Ltd, Larnaka (Vertragspartner für Kunden in der EU)", en: "Hostinger International Ltd, Larnaca (contracting party for customers in the EU)" },
		country: "CY",
		facts: {
			de: "Infrastruktur und Betrieb in Litauen, Vertragspartner je nach Kundenland: Zypern (EU), Hostinger UK Ltd (Großbritannien), HOSTINGER PTE LTD (Singapur). Nimmt Herausgabe- und Sicherungsanordnungen an; löscht Kundendaten 30 Tage nach Vertragsende, Kontodaten nach einer Sperrung wegen Missbrauchs nach bis zu 1 Jahr.",
			en: "Infrastructure and operations in Lithuania; the contracting party depends on the customer's country: Cyprus (EU), Hostinger UK Ltd (UK), HOSTINGER PTE LTD (Singapore). Accepts production and preservation orders; deletes customer data 30 days after the contract ends, account data after an abuse suspension after up to a year.",
		},
		source: "https://www.hostinger.com/legal/universal-terms-of-service-agreement",
	},
	{
		pattern: /digitalocean/i,
		holder: { de: "DigitalOcean, LLC", en: "DigitalOcean, LLC" },
		country: "US",
		facts: {
			de: "Sichert Kontodaten auf Ersuchen 90 Tage (einmal verlängerbar); Serverinhalte (Droplets) werden beim Löschen sofort vernichtet.",
			en: "Preserves account data for 90 days on request (renewable once); server content (droplets) is destroyed immediately on deletion.",
		},
		source: "https://www.digitalocean.com/legal/law-enforcement-guidelines",
	},
	{
		pattern: /github/i,
		holder: { de: "GitHub, Inc.", en: "GitHub, Inc." },
		country: "US",
		facts: { de: "Sichert Daten auf förmliches Ersuchen einer Strafverfolgungsbehörde 90 Tage.", en: "Preserves data for 90 days on a formal law-enforcement request." },
		source: "https://docs.github.com/en/site-policy/other-site-policies/guidelines-for-legal-requests-of-user-data",
	},
	{
		pattern: /google|firebase|blogspot/i,
		holder: { de: "Google LLC", en: "Google LLC" },
		country: "US",
		facts: { de: "Sicherungs- und Herausgabeersuchen über das Law Enforcement Request System (LERS).", en: "Preservation and disclosure requests through the Law Enforcement Request System (LERS)." },
		source: "https://lers.google.com/",
	},
	{
		pattern: /namecheap/i,
		holder: { de: "Namecheap, Inc.", en: "Namecheap, Inc." },
		country: "US",
		facts: {
			de: "Registrar. Registrierungs- und Zahlungsdaten über legal@namecheap.com; ausländische Behörden nach eigener Angabe über Rechtshilfe. Registrierungsdaten bis 2 Jahre nach Ende der Registrierung (ICANN-Vertrag).",
			en: "Registrar. Registration and payment data through legal@namecheap.com; foreign agencies through mutual legal assistance, as it states. Registration data up to 2 years after a registration ends (ICANN contract).",
		},
		source: "https://www.namecheap.com/legal/general/domain-registration-data-disclosure-policy-guide/",
	},
	{
		pattern: /hetzner/i,
		holder: { de: "Hetzner Online GmbH", en: "Hetzner Online GmbH" },
		country: "DE",
		facts: { de: "Beantwortet nur Ersuchen deutscher (für Helsinki finnischer) Behörden.", en: "Answers only German authorities (Finnish ones for Helsinki)." },
		source: "https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner/",
	},
	{
		pattern: /ovh/i,
		holder: { de: "OVH SAS, Roubaix", en: "OVH SAS, Roubaix" },
		country: "FR",
		facts: { de: "Ersuchen über die Rechtsabteilung in Roubaix.", en: "Requests through its legal department in Roubaix." },
		source: "https://us.ovhcloud.com/legal/faqs/legal-law-enforcement/",
	},
	{
		pattern: /render/i,
		holder: { de: "Render Services, Inc.", en: "Render Services, Inc." },
		country: "US",
		facts: { de: "Hoster der Seiten (onrender.com); hält Konto-, Zahlungs- und Zugriffsdaten. Die Subdomain unter onrender.com identifiziert das Kundenkonto.", en: "Hosts the pages (onrender.com); holds account, payment and access-log data. The onrender.com subdomain identifies the customer account." },
	},
	{
		pattern: /\b20i\b/i,
		holder: { de: "20i Ltd", en: "20i Ltd" },
		country: "GB",
		facts: { de: "Bewahrt Hosting-Daten nur 30 Tage, Sicherungskopien 12 Monate auf.", en: "Keeps web-hosting data for only 30 days, backups for 12 months." },
		source: "https://www.20i.com/legal/20i-ltd-privacy-policy",
	},
	{
		pattern: /alibaba|aliyun/i,
		holder: { de: "Alibaba Cloud (Singapore) Private Limited bzw. die EU-Gesellschaft für Kunden in der EU", en: "Alibaba Cloud (Singapore) Private Limited, or the EU entity for customers in the EU" },
		country: "SG",
		facts: { de: "Die internationale Alibaba Cloud ist meist keine chinesische Infrastruktur im Rechtssinn; Vertragspartner zuerst prüfen. Ist es eine EU-Gesellschaft, greift die Europäische Herausgabeanordnung.", en: "Alibaba Cloud International is usually not Chinese infrastructure in law; check the contracting entity first. If it is an EU entity, a European Production Order applies." },
		source: "https://www.alibabacloud.com/help/faq-detail/42427.htm",
	},
	{
		pattern: /eranet/i,
		holder: { de: "Eranet International Limited (Registrar)", en: "Eranet International Limited (registrar)" },
		country: "HK",
		facts: { de: "Registrar mit Sitz in Hongkong; es gilt Hongkonger, nicht chinesisches Recht.", en: "Registrar based in Hong Kong; Hong Kong law applies, not PRC law." },
		source: "https://www.iana.org/assignments/registrar-ids/registrar-ids.xhtml",
	},
	{
		pattern: /tucows/i,
		holder: { de: "Tucows Domains Inc. (Registrar)", en: "Tucows Domains Inc. (registrar)" },
		country: "CA",
		facts: { de: "Registrar mit Sitz in Kanada.", en: "Registrar based in Canada." },
	},
	{
		pattern: /godaddy/i,
		holder: { de: "GoDaddy.com, LLC", en: "GoDaddy.com, LLC" },
		country: "US",
		facts: { de: "Registrar und Hoster mit Sitz in den USA.", en: "Registrar and host based in the USA." },
	},
	{
		pattern: /namesilo/i,
		holder: { de: "NameSilo, LLC (Registrar)", en: "NameSilo, LLC (registrar)" },
		country: "US",
		facts: { de: "Registrar mit Sitz in den USA.", en: "Registrar based in the USA." },
	},
	{
		pattern: /dynadot/i,
		holder: { de: "Dynadot Inc (Registrar)", en: "Dynadot Inc (registrar)" },
		country: "US",
		facts: { de: "Registrar mit Sitz in den USA.", en: "Registrar based in the USA." },
	},
	{
		pattern: /gname/i,
		holder: { de: "Gname.com Pte. Ltd. (Registrar)", en: "Gname.com Pte. Ltd. (registrar)" },
		country: "SG",
		facts: { de: "Registrar mit Sitz in Singapur.", en: "Registrar based in Singapore." },
	},
	{
		pattern: /publicdomainregistry|\bPDR Ltd/i,
		holder: { de: "PDR Ltd. d/b/a PublicDomainRegistry.com (Registrar)", en: "PDR Ltd. d/b/a PublicDomainRegistry.com (registrar)" },
		country: "IN",
		facts: { de: "Registrar mit Sitz in Indien.", en: "Registrar based in India." },
	},
	{
		pattern: /registrar\.eu|hosting concepts|realtime register/i,
		holder: { de: "Hosting Concepts B.V. d/b/a Registrar.eu (Registrar)", en: "Hosting Concepts B.V. d/b/a Registrar.eu (registrar)" },
		country: "NL",
		facts: { de: "Registrar mit Sitz in den Niederlanden (Realtime-Register-Gruppe).", en: "Registrar based in the Netherlands (Realtime Register group)." },
	},
	{
		pattern: /telegram/i,
		holder: { de: "Telegram FZ-LLC", en: "Telegram FZ-LLC" },
		country: "AE",
		facts: {
			de: "Gibt seit 09/2024 IP-Adresse und Telefonnummer eines Kontos auf gerichtliche Anordnung heraus, die einen Tatverdächtigen benennt. Bot-ID, Bot-Name und Chat-ID unter den verbindenden Merkmalen identifizieren das empfangende Konto.",
			en: "Since 09/2024 discloses an account's IP address and phone number on a court order that names a suspect. The bot ID, bot name and chat ID under the linking indicators identify the receiving account.",
		},
	},
	{
		pattern: /discord/i,
		holder: { de: "Discord Inc.", en: "Discord Inc." },
		country: "US",
		facts: {
			de: "Sicherungs- und Herausgabeersuchen über das Behördenverfahren von Discord; Webhook-ID und Kanal-ID unter den verbindenden Merkmalen identifizieren den empfangenden Server.",
			en: "Preservation and disclosure requests through Discord's law-enforcement process; the webhook ID and channel ID under the linking indicators identify the receiving server.",
		},
	},
];

/** The lead for any name the case recorded for a provider (display name, mailbox, network name), if one is known. */
export function providerLead(...names: Array<string | undefined>): ProviderLead | undefined {
	const haystack = names.filter(Boolean).join(" ");
	const found = LEADS.find((lead) => lead.pattern.test(haystack));
	if (!found) return undefined;
	const { pattern: _pattern, ...lead } = found;
	return lead;
}
