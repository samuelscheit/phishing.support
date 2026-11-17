/**
 * How an investigator reaches the records a provider keeps about a phishing
 * customer, from each provider's own law-enforcement guidance (sources in
 * docs/research/criminal-referral-routes.md). Shown in the dossier so the
 * authority can secure the data before the provider deletes it: in German
 * for the complaint mails, in English for the evidence archive.
 */
export type ProviderLead = {
	provider: string;
	/** What data exists and which instrument reaches it, in German. */
	lead: string;
	providerEn: string;
	leadEn: string;
	source?: string;
};

const LEADS: ReadonlyArray<{ pattern: RegExp } & ProviderLead> = [
	{
		pattern: /cloudflare/i,
		provider: "Cloudflare, Inc. (USA)",
		lead: "CDN/Proxy, kein Hoster der Inhalte. Kundenkonto, Zahlungsdaten und Ursprungsserver (Origin-IP) des Kontos über Ersuchen an lawenforcement@cloudflare.com; Bestandsdaten nach US-Recht per Subpoena, Sicherung über das 24/7-Netz bzw. 18 U.S.C. § 2703(f).",
		providerEn: "Cloudflare, Inc. (USA)",
		leadEn: "CDN/proxy, not the host of the content. The account, its payment data and its origin server through a request to lawenforcement@cloudflare.com; subscriber data by US subpoena, preservation through the 24/7 network or 18 U.S.C. § 2703(f).",
		source: "https://www.cloudflare.com/trust-hub/law-enforcement/",
	},
	{
		pattern: /hostinger/i,
		provider: "Hostinger (Litauen/EU)",
		lead: "Eigenes Sicherungsverfahren für Ermittlungsbehörden (Ersuchen auf Behördenbriefkopf). Kundendaten werden 30 Tage nach Vertragsende gelöscht; Kontodaten nach einer Sperrung wegen Missbrauchs bis zu 1 Jahr. EU-Anbieter: Europäische Sicherungsanordnung nach VO (EU) 2023/1543 möglich.",
		providerEn: "Hostinger (Lithuania, EU)",
		leadEn: "Has its own preservation process for law enforcement (request on agency letterhead). Customer data is deleted 30 days after the contract ends; account data after an abuse suspension is kept up to a year. EU provider: a European Preservation Order under Regulation (EU) 2023/1543 applies.",
		source: "https://www.hostinger.com/legal/abuse-policy",
	},
	{
		pattern: /digitalocean/i,
		provider: "DigitalOcean, LLC (USA)",
		lead: "Sichert Kontodaten auf Ersuchen nach 18 U.S.C. § 2703(f) für 90 Tage (einmal verlängerbar). Serverinhalte (Droplets) werden beim Löschen sofort vernichtet.",
		providerEn: "DigitalOcean, LLC (USA)",
		leadEn: "Preserves account data for 90 days (renewable once) on an 18 U.S.C. § 2703(f) request. Server content (droplets) is destroyed immediately on deletion.",
		source: "https://www.digitalocean.com/legal/law-enforcement-guidelines",
	},
	{
		pattern: /github/i,
		provider: "GitHub, Inc. (USA)",
		lead: "Sichert Daten auf förmliches Ersuchen einer Strafverfolgungsbehörde für 90 Tage.",
		providerEn: "GitHub, Inc. (USA)",
		leadEn: "Preserves data for 90 days on a formal law-enforcement request.",
		source: "https://docs.github.com/en/site-policy/other-site-policies/guidelines-for-legal-requests-of-user-data",
	},
	{
		pattern: /google|firebase|blogspot/i,
		provider: "Google LLC (USA)",
		lead: "Sicherungs- und Herausgabeersuchen über das Law Enforcement Request System (LERS) von Google.",
		providerEn: "Google LLC (USA)",
		leadEn: "Preservation and disclosure requests through Google's Law Enforcement Request System (LERS).",
		source: "https://lers.google.com/",
	},
	{
		pattern: /namecheap/i,
		provider: "Namecheap, Inc. (USA)",
		lead: "Registrar. Registrierungs- und Zahlungsdaten über legal@namecheap.com; ausländische Behörden nach eigener Angabe über Rechtshilfe. Nach ICANN-Vertrag bewahrt der Registrar Registrierungsdaten bis 2 Jahre nach Ende der Registrierung auf.",
		providerEn: "Namecheap, Inc. (USA)",
		leadEn: "Registrar. Registration and payment data through legal@namecheap.com; foreign agencies through mutual legal assistance, as it states. Under its ICANN contract it keeps registration data up to 2 years after a registration ends.",
		source: "https://www.namecheap.com/legal/general/domain-registration-data-disclosure-policy-guide/",
	},
	{
		pattern: /hetzner/i,
		provider: "Hetzner Online GmbH (Deutschland)",
		lead: "Beantwortet nur Ersuchen deutscher (bzw. für Helsinki finnischer) Behörden: Herausgabeverlangen nach § 95 StPO, Bestandsdaten nach § 100j StPO / TDDDG.",
		providerEn: "Hetzner Online GmbH (Germany)",
		leadEn: "Answers only German authorities (Finnish ones for Helsinki): production orders under § 95 StPO, subscriber data under § 100j StPO / TDDDG.",
		source: "https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner/",
	},
	{
		pattern: /ovh/i,
		provider: "OVH SAS (Frankreich/EU)",
		lead: "Ersuchen über die Rechtsabteilung in Roubaix; als EU-Anbieter Europäische Sicherungs- und Herausgabeanordnung nach VO (EU) 2023/1543.",
		providerEn: "OVH SAS (France, EU)",
		leadEn: "Requests through its legal department in Roubaix; as an EU provider, European Preservation and Production Orders under Regulation (EU) 2023/1543.",
		source: "https://us.ovhcloud.com/legal/faqs/legal-law-enforcement/",
	},
	{
		pattern: /render/i,
		provider: "Render Services, Inc. (USA)",
		lead: "Hoster der Seiten (onrender.com). Kontodaten, Zahlungsdaten und Zugriffsprotokolle über ein Ersuchen nach US-Recht; Sicherung über das 24/7-Netz bzw. 18 U.S.C. § 2703(f).",
		providerEn: "Render Services, Inc. (USA)",
		leadEn: "Hosts the pages (onrender.com). Account, payment and access-log data through a US legal request; preservation through the 24/7 network or 18 U.S.C. § 2703(f).",
	},
	{
		pattern: /telegram/i,
		provider: "Telegram (Telegram FZ-LLC, VAE)",
		lead: "Gibt seit 09/2024 IP-Adresse und Telefonnummer eines Kontos auf gerichtliche Anordnung heraus, die einen Tatverdächtigen benennt. Bot-ID, Bot-Name und Chat-ID unter den verbindenden Merkmalen identifizieren das empfangende Konto.",
		providerEn: "Telegram (Telegram FZ-LLC, UAE)",
		leadEn: "Since 09/2024 discloses an account's IP address and phone number on a court order that names a suspect. The bot ID, bot name and chat ID under the linking indicators identify the receiving account.",
	},
	{
		pattern: /discord/i,
		provider: "Discord Inc. (USA)",
		lead: "Sicherungs- und Herausgabeersuchen von Strafverfolgungsbehörden über das Behördenverfahren von Discord; Webhook-ID und Kanal-ID unter den verbindenden Merkmalen identifizieren den empfangenden Server.",
		providerEn: "Discord Inc. (USA)",
		leadEn: "Preservation and disclosure requests through Discord's law-enforcement process; the webhook ID and channel ID under the linking indicators identify the receiving server.",
	},
];

/** The lead for a provider name as the resolver recorded it, if one is known. */
export function providerLead(providerName: string): ProviderLead | undefined {
	const found = LEADS.find((lead) => lead.pattern.test(providerName));
	if (!found) return undefined;
	const { pattern: _pattern, ...lead } = found;
	return lead;
}

/** The instruments that reach a provider without a specific lead. */
export const GENERIC_LEAD = "Anbieter mit Sitz in der EU: Europäische Sicherungs- und Herausgabeanordnung (VO (EU) 2023/1543, seit 18.08.2026). Anbieter in den USA: Sicherungsersuchen nach 18 U.S.C. § 2703(f) über das 24/7-Netz der Budapest-Konvention. Anbieter in Deutschland: Herausgabeverlangen nach § 95 StPO, Bestandsdaten nach § 100j StPO.";
export const GENERIC_LEAD_EN = "Providers in the EU: European Preservation and Production Orders (Regulation (EU) 2023/1543, applicable since 18 Aug 2026). Providers in the USA: preservation requests under 18 U.S.C. § 2703(f) through the Budapest Convention's 24/7 network. Providers in Germany: production orders under § 95 StPO, subscriber data under § 100j StPO.";
