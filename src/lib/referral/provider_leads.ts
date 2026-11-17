/**
 * How an investigator reaches the records a provider keeps about a phishing
 * customer, from each provider's own law-enforcement guidance (sources in
 * docs/research/criminal-referral-routes.md). Shown in the dossier so the
 * authority can secure the data before the provider deletes it.
 */
export type ProviderLead = {
	provider: string;
	/** German text for the dossier: what data exists and which instrument reaches it. */
	lead: string;
	source?: string;
};

const LEADS: ReadonlyArray<{ pattern: RegExp } & ProviderLead> = [
	{
		pattern: /cloudflare/i,
		provider: "Cloudflare, Inc. (USA)",
		lead: "CDN/Proxy, kein Hoster der Inhalte. Kundenkonto, Zahlungsdaten und Ursprungsserver (Origin-IP) des Kontos über Ersuchen an lawenforcement@cloudflare.com; Bestandsdaten nach US-Recht per Subpoena, Sicherung über das 24/7-Netz bzw. 18 U.S.C. § 2703(f).",
		source: "https://www.cloudflare.com/trust-hub/law-enforcement/",
	},
	{
		pattern: /hostinger/i,
		provider: "Hostinger (Litauen/EU)",
		lead: "Eigenes Sicherungsverfahren für Ermittlungsbehörden (Ersuchen auf Behördenbriefkopf). Kundendaten werden 30 Tage nach Vertragsende gelöscht; Kontodaten nach einer Sperrung wegen Missbrauchs bis zu 1 Jahr. EU-Anbieter: Europäische Sicherungsanordnung nach VO (EU) 2023/1543 möglich.",
		source: "https://www.hostinger.com/legal/abuse-policy",
	},
	{
		pattern: /digitalocean/i,
		provider: "DigitalOcean, LLC (USA)",
		lead: "Sichert Kontodaten auf Ersuchen nach 18 U.S.C. § 2703(f) für 90 Tage (einmal verlängerbar). Serverinhalte (Droplets) werden beim Löschen sofort vernichtet.",
		source: "https://www.digitalocean.com/legal/law-enforcement-guidelines",
	},
	{
		pattern: /github/i,
		provider: "GitHub, Inc. (USA)",
		lead: "Sichert Daten auf förmliches Ersuchen einer Strafverfolgungsbehörde für 90 Tage.",
		source: "https://docs.github.com/en/site-policy/other-site-policies/guidelines-for-legal-requests-of-user-data",
	},
	{
		pattern: /google|firebase|blogspot/i,
		provider: "Google LLC (USA)",
		lead: "Sicherungs- und Herausgabeersuchen über das Law Enforcement Request System (LERS) von Google.",
		source: "https://lers.google.com/",
	},
	{
		pattern: /namecheap/i,
		provider: "Namecheap, Inc. (USA)",
		lead: "Registrar. Registrierungs- und Zahlungsdaten über legal@namecheap.com; ausländische Behörden nach eigener Angabe über Rechtshilfe. Nach ICANN-Vertrag bewahrt der Registrar Registrierungsdaten bis 2 Jahre nach Ende der Registrierung auf.",
		source: "https://www.namecheap.com/legal/general/domain-registration-data-disclosure-policy-guide/",
	},
	{
		pattern: /hetzner/i,
		provider: "Hetzner Online GmbH (Deutschland)",
		lead: "Beantwortet nur Ersuchen deutscher (bzw. für Helsinki finnischer) Behörden: Herausgabeverlangen nach § 95 StPO, Bestandsdaten nach § 100j StPO / TDDDG.",
		source: "https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner/",
	},
	{
		pattern: /ovh/i,
		provider: "OVH SAS (Frankreich/EU)",
		lead: "Ersuchen über die Rechtsabteilung in Roubaix; als EU-Anbieter Europäische Sicherungs- und Herausgabeanordnung nach VO (EU) 2023/1543.",
		source: "https://us.ovhcloud.com/legal/faqs/legal-law-enforcement/",
	},
	{
		pattern: /telegram/i,
		provider: "Telegram (Telegram FZ-LLC, VAE)",
		lead: "Gibt seit 09/2024 IP-Adresse und Telefonnummer eines Kontos auf gerichtliche Anordnung heraus, die einen Tatverdächtigen benennt. Bot-ID, Bot-Name und Chat-ID unter den verbindenden Merkmalen identifizieren das empfangende Konto.",
	},
	{
		pattern: /discord/i,
		provider: "Discord Inc. (USA)",
		lead: "Sicherungs- und Herausgabeersuchen von Strafverfolgungsbehörden über das Behördenverfahren von Discord; Webhook-ID und Kanal-ID unter den verbindenden Merkmalen identifizieren den empfangenden Server.",
	},
];

/** The lead for a provider name as the resolver recorded it, if one is known. */
export function providerLead(providerName: string): ProviderLead | undefined {
	const found = LEADS.find((lead) => lead.pattern.test(providerName));
	return found ? { provider: found.provider, lead: found.lead, ...(found.source ? { source: found.source } : {}) } : undefined;
}

/** The instruments that reach a provider without a specific lead. */
export const GENERIC_LEAD = "Anbieter mit Sitz in der EU: Europäische Sicherungs- und Herausgabeanordnung (VO (EU) 2023/1543, seit 18.08.2026). Anbieter in den USA: Sicherungsersuchen nach 18 U.S.C. § 2703(f) über das 24/7-Netz der Budapest-Konvention. Anbieter in Deutschland: Herausgabeverlangen nach § 95 StPO, Bestandsdaten nach § 100j StPO.";
