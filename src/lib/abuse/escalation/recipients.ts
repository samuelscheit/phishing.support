import { registrableDomain } from "../security/security";

/**
 * Bodies above the providers that an unanswered report can be escalated to,
 * each checked against its own publication (docs/research/escalation-recipients.md,
 * 2026-11-27). Only mailboxes the body itself, FIRST, Trusted Introducer or
 * APCERT publish are listed; a country whose CERT takes reports only through
 * a web form (GB) or whose mailbox could not be confirmed (RO, US) has none.
 */
export type Recipient = { name: string; email: string; source: string };

/** National CERTs by ISO country of the hosting network, report intake first. */
export const NATIONAL_CERTS: Readonly<Record<string, Recipient>> = {
	AT: { name: "CERT.at", email: "reports@cert.at", source: "https://cert.at/en/" },
	BG: { name: "CERT Bulgaria", email: "cert@govcert.bg", source: "https://www.trusted-introducer.org/trusted-introducer/directory/teams/cert-bulgaria/" },
	BR: { name: "CERT.br", email: "cert@cert.br", source: "https://cert.br/report/" },
	CH: { name: "NCSC (antiphishing.ch)", email: "reports@antiphishing.ch", source: "https://www.ncsc.admin.ch/ncsc/en/home/cyberbedrohungen/phishing.html" },
	CN: { name: "CNCERT/CC", email: "cncert@cert.org.cn", source: "https://www.cert.org.cn/" },
	CZ: { name: "CSIRT.CZ", email: "abuse@csirt.cz", source: "https://www.csirt.cz/en/about-us/contact/" },
	DE: { name: "CERT-Bund", email: "certbund@bsi.bund.de", source: "https://www.first.org/members/teams/cert-bund" },
	FI: { name: "NCSC-FI", email: "cert@ncsc.fi", source: "https://www.trusted-introducer.org/trusted-introducer/directory/teams/ncsc-fi/" },
	FR: { name: "CERT-FR", email: "cert-fr@ssi.gouv.fr", source: "https://www.cert.ssi.gouv.fr/contact/" },
	HK: { name: "HKCERT", email: "hkcert@hkcert.org", source: "https://www.hkcert.org/incident-reporting" },
	ID: { name: "ID-SIRTII/CC", email: "incident@idsirtii.or.id", source: "https://www.apcert.org/about/structure/members.html" },
	IN: { name: "CERT-In", email: "incident@cert-in.org.in", source: "https://www.apcert.org/about/structure/members.html" },
	JP: { name: "JPCERT/CC", email: "info@jpcert.or.jp", source: "https://www.jpcert.or.jp/english/ir/" },
	KR: { name: "KrCERT/CC", email: "first-team@krcert.or.kr", source: "https://www.apcert.org/about/structure/members.html" },
	LT: { name: "NKSC/CERT-LT", email: "cert@nksc.lt", source: "https://www.nksc.lt/en/dns_firewall.html" },
	LV: { name: "CERT.LV", email: "cert@cert.lv", source: "https://cert.lv/uploads/eng/Q2_2026_CERT_LV.pdf" },
	NL: { name: "NCSC-NL", email: "cert@ncsc.nl", source: "https://www.ncsc.nl/contact" },
	PL: { name: "CERT Polska", email: "cert@cert.pl", source: "https://cert.pl/en/contact/" },
	RU: { name: "NCCCI (GOV-CERT.RU)", email: "incident@cert.gov.ru", source: "https://cert.gov.ru/kontakty/" },
	SE: { name: "CERT-SE", email: "cert@cert.se", source: "https://cert.se/en/" },
	SG: { name: "SingCERT", email: "singcert@csa.gov.sg", source: "https://www.csa.gov.sg/resources/singcert/report-a-phishing-email/" },
	TR: { name: "USOM / TR-CERT", email: "trcert@usom.gov.tr", source: "https://www.first.org/members/teams/tr-cert" },
	UA: { name: "CERT-UA", email: "cert@cert.gov.ua", source: "https://www.first.org/members/teams/cert-ua" },
	VN: { name: "VNCERT/CC", email: "ir@vncert.vn", source: "https://www.apcert.org/about/structure/members.html" },
};

/**
 * Phishing mailboxes brands publish on their own pages for fake sites too,
 * by the brand's registrable domain. A mailbox only for spoofed email
 * (Amazon's stop-spoofing@) is not one.
 */
export const BRAND_PHISHING_MAILBOXES: Readonly<Record<string, Recipient>> = {
	"apple.com": { name: "Apple", email: "reportphishing@apple.com", source: "https://support.apple.com/en-us/102568" },
	"dhl.com": { name: "DHL", email: "phishing@dhl.com", source: "https://www.dhl.com/global-en/home/footer/fraud-awareness.html" },
	"netflix.com": { name: "Netflix", email: "phishing@netflix.com", source: "https://help.netflix.com/en/node/65674" },
	"paypal.com": { name: "PayPal", email: "phishing@paypal.com", source: "https://www.paypal.com/us/security/report-suspicious-activity" },
};

/** The brand a report says the site impersonates, when the brand publishes a phishing mailbox. */
export function brandRecipient(brandUrl: string | null | undefined): Recipient | undefined {
	if (!brandUrl) return undefined;
	try {
		const domain = registrableDomain(new URL(brandUrl).hostname);
		return domain ? BRAND_PHISHING_MAILBOXES[domain] : undefined;
	} catch {
		return undefined;
	}
}

/** Where the Digital Services Act applies to a host: the EU and the EEA states that took it over. */
export const DSA_COUNTRIES: ReadonlySet<string> = new Set([
	"AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
	"IS", "LI", "NO",
]);

/**
 * ICANN takes complaints about an accredited registrar's handling of DNS
 * abuse through its web form only, for gTLD domains only, after the
 * registrar was reported and had a reasonable time (RAA §3.18.1-2).
 */
export const ICANN_COMPLAINT = {
	name: "ICANN Contractual Compliance",
	formUrl: "https://www.icann.org/compliance/complaint",
	source: "https://www.icann.org/en/system/files/files/submitting-dns-abuse-complaints-icann-guide-17nov25-en.pdf",
} as const;

/** A generic top-level domain, which ICANN oversees; a two-letter TLD is a country's. */
export function isGenericTld(domain: string): boolean {
	const tld = domain.toLowerCase().replace(/\.$/, "").split(".").at(-1) ?? "";
	return tld.length > 2 || tld.startsWith("xn--");
}
