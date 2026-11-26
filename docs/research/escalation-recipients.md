# Escalation recipients: research

Checked 2026-11-27. "Verified" = read on the named official page this session (fetch/curl). "Reported" = shown by a search summary of the official page, or by FIRST/APCERT/TI listing, not directly opened. Unmarked scope claims are unknown.

## 1. National CERTs/CSIRTs

Caveats: no CERT publishes a guarantee that it processes third-party reports about hosting in its country. Constituency wording is mostly "incidents in our country/constituency". Treat CERT mail as a best-effort cc, not a takedown channel. Sources: FIRST API `https://api.first.org/data/v1/teams` (public, JSON, has `email` per team; checked 2026-11-27), APCERT member page, Trusted Introducer (TI) directory, CERT's own site.

| CC | Team | Email | Source | Status / notes |
|---|---|---|---|---|
| DE | CERT-Bund (BSI) | certbund@bsi.bund.de | https://www.first.org/members/teams/cert-bund ; BSI contact page https://www.bsi.bund.de/EN/Themen/Unternehmen-und-Organisationen/Cyber-Sicherheitslage/Reaktion/CERT-Bund/Kontakt/kontakt.html ; security.txt https://www.bsi.bund.de/static/security/security.txt | FIRST verified (API); BSI page reported. Constituency: federal government, KRITIS, industry, citizens. German/English. Hoster/network operators get notified via reports.cert-bund.de, not mail. |
| NL | NCSC-NL | cert@ncsc.nl | https://www.ncsc.nl/contact (address in page source, verified) ; FIRST `ncsc-nl` | Verified. Page targets organisations; third-party phishing reports not mentioned. Dutch/English. Web form https://www.ncsc.nl/cyberincidenten-melden-bij-het-ncsc. |
| FR | CERT-FR (ANSSI) | cert-fr@ssi.gouv.fr | https://www.cert.ssi.gouv.fr/contact/ | Verified. Page states "Le CERT-FR n'est pas un service de justice ou de police recevant des plaintes". Constituency: administrations/operators; low value for random phishing. French (English ok). |
| US | CISA | report@cisa.gov | CISA/NSA/FBI phishing guidance PDF https://www.cisa.gov/sites/default/files/2025-03/Phishing%20Guidance%20-%20Stopping%20the%20Attack%20Cycle%20at%20Phase%20One%20508.pdf | Reported. https://www.cisa.gov/report shows only forms+phone (888-282-0870), email text stripped in fetch. Legacy `phishing-report@us-cert.gov` appears only in old material: do not use. |
| US | APWG (not a CERT) | reportphishing@apwg.org | https://apwg.org/reportphishing/ | Verified. Forward phishing email (as attachment); fallback web form https://apwg.org/submissions/report-phishing for URLs. Feeds blocklists, no takedown. |
| GB | NCSC UK | (none verified) | https://www.ncsc.gov.uk/section/about-this-website/report-scam-website | NCSC says it analyses reported sites and "work[s] with hosting companies to remove links". Website intake is a form, not email. `report@phishing.gov.uk` (Suspicious Email Reporting Service) is for emails only and is obfuscated on ncsc.gov.uk; seen only on a council page: unverified. FIRST lists no email. |
| RU | NCCCI / GOV-CERT.RU | incident@cert.gov.ru | https://cert.gov.ru/kontakty/ ; address also found in site HTML https://cert.gov.ru/ | Reported/HTML. Government-oriented, Russian. `info@cert.gov.ru` general, `threats@cert.gov.ru`. |
| RU | RU-CERT (Coordination Center .RU) | info@cert.ru | https://www.cert.ru/en/abuse.shtml (page says email is preferred; address shown on page) ; FIRST `ru-cert` | Verified (FIRST + page). For .RU/.РФ domains the Coordination Center removes delegation via "competent organisations" (https://cctld.ru/help/safety/competent/, https://cctld.ru/en/media/news/kc/39179/). Hotline aggregator: tldpatrol.ru. |
| CN | CNCERT/CC | cncert@cert.org.cn | https://www.cert.org.cn/ (address in HTML, verified) ; APCERT https://www.apcert.org/about/structure/members.html | Verified. Weekly reports show phishing takedowns with registrars. A 2026 weekly report lists `cncert_report@cert.org.cn` (https://www.cert.org.cn/publish/english/upload/File/Weekly%20Report%20of%20CNCERT-Issue%2002%202026%20EN.pdf): unresolved which is live. English hotline +8610 82991000. |
| SG | SingCERT (CSA) | singcert@csa.gov.sg | https://www.csa.gov.sg/resources/singcert/report-a-phishing-email/ ; HTML of https://www.csa.gov.sg/singcert | Verified. Form preferred: https://form.gov.sg/63d792498de0970012f57c74. Third-party guide says Singapore-based incidents only. |
| HK | HKCERT | hkcert@hkcert.org | https://www.hkcert.org/ (HTML verified) ; https://www.hkcert.org/incident-reporting | Verified. Form: https://www.hkcert.org/incident-reporting; 24h hotline +852 8105 6060. Phishing listed as in-scope incident. GovCERT.HK `cert@govcert.gov.hk` is government-only. |
| LT | NKSC/CERT-LT | cert@nksc.lt | FIRST `nksc-cert-lt`; https://www.nksc.lt/en/dns_firewall.html | FIRST verified. Reported: NKSC says malicious sites can be reported to cert@nksc.lt. Old `cert@cert.lt` is outdated. |
| LV | CERT.LV | cert@cert.lv | https://cert.lv/uploads/par-mums/RFC_2350_CERT-LV_21072025.pdf ; https://cert.lv/uploads/eng/Q2_2026_CERT_LV.pdf | Reported. Q2 2026 report: forward emails, SMS and website links to cert@cert.lv. Latvian/English. |
| PL | CERT Polska (NASK) | cert@cert.pl | https://cert.pl/en/contact/ (cf-decoded: cert@cert.pl incident contact, info@cert.pl general) ; FIRST `cert_polska` | Verified. Preferred: form https://incydent.cert.pl ; SMS-URL: forward to 8080. English fine. |
| CZ | CSIRT.CZ | abuse@csirt.cz | https://www.csirt.cz/en/about-us/contact/ ; https://www.csirt.cz/en/incident-reporting/how-report/ ; FIRST `csirt-cz` | FIRST verified, page reported. Requires: phishing URL (+ page source/screenshot), name+org, valid sender, subject with IP and type, one IP/block per report. `reports@csirt.cz` not found anywhere. GovCERT.CZ `cert@nukib.gov.cz` is NÚKIB (government). |
| BG | CERT Bulgaria | cert@govcert.bg | https://www.govcert.bg/en/contact-us/ ; TI https://www.trusted-introducer.org/trusted-introducer/directory/teams/cert-bulgaria/ (verified in TI page) | Verified (TI). Form https://www.govcert.bg/en/report-an-incident/. |
| RO | CERT-RO (DNSC) | alerts@cert.ro | https://www.dnsc.ro/vezi/document/RFC2350-CERT-RO ; https://cert.ro/contact | Reported (RFC 2350; may be dated). RFC: phishing/pharming reports should include URL and page source. General `csirt@cert.ro`/`office@cert.ro` conflict. No FIRST/TI email found. Phone 1911. |
| UA | CERT-UA | cert@cert.gov.ua | FIRST `cert-ua` ; https://cert.gov.ua/article/6277840 | FIRST verified. Page (reported) separates `incidents@cert.gov.ua` (reports) from `cert@` (general). Ukrainian/English. |
| SE | CERT-SE (MCF) | cert@cert.se | https://cert.se/en/ | Verified. "To reach us, email cert@cert.se". NIS entities use https://cyberportal.mcf.se/. |
| FI | NCSC-FI (Traficom) | cert@ncsc.fi | FIRST `ncsc-fi`; TI https://www.trusted-introducer.org/trusted-introducer/directory/teams/ncsc-fi/ | FIRST verified. Automated-report mailbox `cert@traficom.fi` (TI, and https://traficom.fi/en/what-do-if-you-detect-information-security-incident-1) reported. NCSC-FI says it investigates the link and takes down malicious sites (weekly review 06/2025). Form on site. |
| CH | NCSC (BACS), antiphishing.ch | reports@antiphishing.ch | https://www.ncsc.admin.ch/ncsc/en/home/cyberbedrohungen/phishing.html | Reported. Automated mailbox, no reply; NCSC forwards sites to hosters/registrars and can block .ch/.swiss. FIRST lists `incidents@govcert.ch` (`ncsc-ch`); antiphishing.ch contact lists incidents@ncsc.ch. |
| AT | CERT.at | reports@cert.at | https://cert.at/en/ and https://www.cert.at/de/ueber-uns/kontakt/ (both verified in HTML) ; TI https://trusted-introducer.org/trusted-introducer/directory/teams/certat/ | Verified. `reports@cert.at` = automated reports; `team@cert.at` = human. Constituency: Austria. |
| CA | Canadian Centre for Cyber Security | contact@cyber.gc.ca | https://www.cyber.gc.ca/en/contact-us (verified in HTML) | Verified address, but guidance routes reports through the online portal ("My Cyber Portal"); email for follow-up. FIRST lists `international@cyber.gc.ca`. |
| JP | JPCERT/CC | info@jpcert.or.jp | https://www.jpcert.or.jp/form/ (verified in HTML) ; https://www.jpcert.or.jp/english/ir/ | Verified. Takedown coordination in Japan: subject "サイト停止希望", URL required, via incident report form (antiphishing guideline 2026 https://www.antiphishing.jp/report/antiphishing_guideline_2026.pdf, reported). Council of Anti-Phishing Japan intake at https://www.antiphishing.jp/registration.html (address obfuscated; use form). Japanese preferred. |
| KR | KrCERT/CC (KISA) | first-team@krcert.or.kr | APCERT members page (verified): `first-team@` English, `certgen@krcert.or.kr` Korean ; FIRST `krcert-cc` | Verified. Portal https://www.boho.or.kr, hotline 118. Korean strongly preferred. |
| IN | CERT-In | incident@cert-in.org.in | https://www.cert-in.org.in/PDF/certinirform.pdf ; APCERT page | APCERT verified, form PDF reported. FIRST lists `info@cert-in.org.in`. Form-based incident format. |
| TR | USOM / TR-CERT | trcert@usom.gov.tr | FIRST `tr-cert` ; https://www.usom.gov.tr/ihbar-bildir.html | FIRST verified. USOM page (reported) lists `ihbar@usom.gov.tr` for reports; notice that USOM listings migrate to siberguvenlik.gov.tr. Turkish preferred. |
| BR | CERT.br (NIC.br) | cert@cert.br | https://cert.br/report/ ; https://cert.br/docs/notificacoes/ ; FIRST `cert-br` | Reported + FIRST verified. Email only, no forms/phone. Asks reporters to write to the network/domain contact and keep cert@cert.br in Cc; publishes phishing notification templates. Spam: mail-abuse@cert.br. Portuguese/English. |
| VN | VNCERT/CC | ir@vncert.vn | APCERT members page (verified) | Verified via APCERT only. vncert.vn site shows contact@vncert.vn / 0692 205 188; old domain `ir@vncert.gov.vn` outdated. Vietnamese preferred. |
| ID | ID-SIRTII/CC | incident@idsirtii.or.id | APCERT page (verified): `incident@idsirtii.or.id`, alt `bantuan70@bssn.go.id` ; https://idsirtii.or.id/en/page/contact-us.html (reported: bantuan70@ primary) | Verified via APCERT. FIRST lists `info@idsirtii.or.id`. Alternative: ID-CERT (separate org, https://idcert.or.id/rfc/en/, phishing alias not found). |

### TypeScript table

```ts
export type CertRecipient = {
  country: string; // ISO 3166-1 alpha-2
  name: string;
  email: string;
  sourceUrl: string;
  /** "reports" = automated/report-intake mailbox; "team" = human/general */
  kind: "reports" | "team";
};

export const NATIONAL_CERTS: readonly CertRecipient[] = [
  { country: "DE", name: "CERT-Bund", email: "certbund@bsi.bund.de", sourceUrl: "https://www.first.org/members/teams/cert-bund", kind: "team" },
  { country: "NL", name: "NCSC-NL", email: "cert@ncsc.nl", sourceUrl: "https://www.ncsc.nl/contact", kind: "team" },
  { country: "FR", name: "CERT-FR", email: "cert-fr@ssi.gouv.fr", sourceUrl: "https://www.cert.ssi.gouv.fr/contact/", kind: "team" },
  { country: "US", name: "CISA", email: "report@cisa.gov", sourceUrl: "https://www.cisa.gov/sites/default/files/2025-03/Phishing%20Guidance%20-%20Stopping%20the%20Attack%20Cycle%20at%20Phase%20One%20508.pdf", kind: "reports" },
  { country: "US", name: "APWG", email: "reportphishing@apwg.org", sourceUrl: "https://apwg.org/reportphishing/", kind: "reports" },
  { country: "RU", name: "NCCCI (GOV-CERT.RU)", email: "incident@cert.gov.ru", sourceUrl: "https://cert.gov.ru/kontakty/", kind: "reports" },
  { country: "RU", name: "RU-CERT", email: "info@cert.ru", sourceUrl: "https://www.cert.ru/en/abuse.shtml", kind: "team" },
  { country: "CN", name: "CNCERT/CC", email: "cncert@cert.org.cn", sourceUrl: "https://www.cert.org.cn/", kind: "reports" },
  { country: "SG", name: "SingCERT", email: "singcert@csa.gov.sg", sourceUrl: "https://www.csa.gov.sg/resources/singcert/report-a-phishing-email/", kind: "reports" },
  { country: "HK", name: "HKCERT", email: "hkcert@hkcert.org", sourceUrl: "https://www.hkcert.org/incident-reporting", kind: "reports" },
  { country: "LT", name: "NKSC/CERT-LT", email: "cert@nksc.lt", sourceUrl: "https://www.nksc.lt/en/dns_firewall.html", kind: "reports" },
  { country: "LV", name: "CERT.LV", email: "cert@cert.lv", sourceUrl: "https://cert.lv/uploads/eng/Q2_2026_CERT_LV.pdf", kind: "reports" },
  { country: "PL", name: "CERT Polska", email: "cert@cert.pl", sourceUrl: "https://cert.pl/en/contact/", kind: "reports" },
  { country: "CZ", name: "CSIRT.CZ", email: "abuse@csirt.cz", sourceUrl: "https://www.csirt.cz/en/about-us/contact/", kind: "reports" },
  { country: "BG", name: "CERT Bulgaria", email: "cert@govcert.bg", sourceUrl: "https://www.trusted-introducer.org/trusted-introducer/directory/teams/cert-bulgaria/", kind: "team" },
  { country: "RO", name: "CERT-RO", email: "alerts@cert.ro", sourceUrl: "https://www.dnsc.ro/vezi/document/RFC2350-CERT-RO", kind: "reports" },
  { country: "UA", name: "CERT-UA", email: "cert@cert.gov.ua", sourceUrl: "https://www.first.org/members/teams/cert-ua", kind: "team" },
  { country: "SE", name: "CERT-SE", email: "cert@cert.se", sourceUrl: "https://cert.se/en/", kind: "team" },
  { country: "FI", name: "NCSC-FI", email: "cert@ncsc.fi", sourceUrl: "https://www.trusted-introducer.org/trusted-introducer/directory/teams/ncsc-fi/", kind: "team" },
  { country: "CH", name: "NCSC (antiphishing.ch)", email: "reports@antiphishing.ch", sourceUrl: "https://www.ncsc.admin.ch/ncsc/en/home/cyberbedrohungen/phishing.html", kind: "reports" },
  { country: "AT", name: "CERT.at", email: "reports@cert.at", sourceUrl: "https://cert.at/en/", kind: "reports" },
  { country: "CA", name: "Canadian Centre for Cyber Security", email: "contact@cyber.gc.ca", sourceUrl: "https://www.cyber.gc.ca/en/contact-us", kind: "team" },
  { country: "JP", name: "JPCERT/CC", email: "info@jpcert.or.jp", sourceUrl: "https://www.jpcert.or.jp/english/ir/", kind: "reports" },
  { country: "KR", name: "KrCERT/CC", email: "first-team@krcert.or.kr", sourceUrl: "https://www.apcert.org/about/structure/members.html", kind: "reports" },
  { country: "IN", name: "CERT-In", email: "incident@cert-in.org.in", sourceUrl: "https://www.apcert.org/about/structure/members.html", kind: "reports" },
  { country: "TR", name: "USOM / TR-CERT", email: "trcert@usom.gov.tr", sourceUrl: "https://www.first.org/members/teams/tr-cert", kind: "team" },
  { country: "BR", name: "CERT.br", email: "cert@cert.br", sourceUrl: "https://cert.br/report/", kind: "reports" },
  { country: "VN", name: "VNCERT/CC", email: "ir@vncert.vn", sourceUrl: "https://www.apcert.org/about/structure/members.html", kind: "reports" },
  { country: "ID", name: "ID-SIRTII/CC", email: "incident@idsirtii.or.id", sourceUrl: "https://www.apcert.org/about/structure/members.html", kind: "reports" },
] as const;
// GB: no verified email; use NCSC website form https://www.ncsc.gov.uk/section/about-this-website/report-scam-website
```

## 2. ICANN Contractual Compliance (registrar DNS abuse)

Sources checked 2026-11-27.

- **Form:** "Abuse/DNS Abuse (Registrar)" complaint type on https://www.icann.org/compliance/complaint (portal link from ICANN's announcement https://www.icann.org/en/announcements/details/icann-publishes-new-step-by-step-guide-for-submitting-dns-abuse-complaints-20-11-2025-en); form page https://icann-nsp.my.site.com/compliance/s/abuse-domain. Web form only; no source describes email as a submission channel. Confirmation email with case number follows.
- **Guide:** https://www.icann.org/en/system/files/files/submitting-dns-abuse-complaints-icann-guide-17nov25-en.pdf (filename date 2025-11-17; announcement 2025-11-20).
- **Prerequisite:** report to the registrar first, "reasonable time to investigate"; escalate only "if the registrar or registry operator doesn't respond within a reasonable timeframe". No number of days is defined anywhere. Do not file the registrar report and the ICANN complaint on the same day; the issues described must match in both. (ICANN dnsabuse page, quote: "after a reporter has submitted an abuse complaint to the registrar of record ... and after a reasonable time", https://www.icann.org/dnsabuse.) Practical default: ≥ 3 business days, ideally 5, with no response/action.
- **Required evidence** (form page + guide): at least one second-level gTLD domain (ccTLDs excluded; e.g. example.us out of scope) and attachments as evidence; evidence of communications with the registrar incl. bounce-backs and auto-responses; clear explanation of the abuse; screenshots with full URL or the phishing email; why the registrar did not act appropriately; if acting for an impersonated entity, proof of authorization. >5 domains: .csv upload (`domain.tld`, no scheme).
- **Anonymous submission** allowed (may slow handling); don't tick the law-enforcement box unless one. By submitting you consent to ICANN sharing the data with registrar/registry.
- **Scope:** ICANN-accredited registrars and gTLD registries only, not hosting providers or ccTLDs.
- **Registrar abuse contact lookup:** ICANN Lookup https://lookup.icann.org (footer link https://whois.icann.org/en), "Registrar Information".

### RAA §3.18, 2024 Global Amendment (effective 5 Apr 2024)

Source (verified): https://itp.cdn.icann.org/en/files/accredited-registrars/registrar-accreditation-agreement-global-amendment-05apr24-en.htm

> **3.18.1** Registrar shall maintain an abuse contact to receive reports of abuse involving Registered Names sponsored by Registrar, including reports of DNS Abuse and Illegal Activity. Registrar shall publish an email address or webform to receive such reports on, or conspicuously and readily accessible from, the home page of Registrar's website (or in another standardized place that may be designated by ICANN from time to time). Upon receipt of such reports, Registrar shall provide the reporter with confirmation that it has received the report. Registrar shall take reasonable and prompt steps to investigate and respond appropriately to any reports of abuse. For the purposes of this Agreement, "DNS Abuse" means malware, botnets, phishing, pharming, and spam (when spam serves as a delivery mechanism for the other forms of DNS Abuse listed in this Section) as those terms are defined in Section 2.1 of SAC115.
>
> **3.18.2** When Registrar has actionable evidence that a Registered Name sponsored by Registrar is being used for DNS Abuse, Registrar must promptly take the appropriate mitigation action(s) that are reasonably necessary to stop, or otherwise disrupt, the Registered Name from being used for DNS Abuse. Action(s) may vary depending on the circumstances, taking into account the cause and severity of the harm from the DNS Abuse and the possibility of associated collateral damage.
>
> **3.18.3** [24/7 law-enforcement abuse contact; well-founded Illegal Activity reports reviewed within 24 hours.]
>
> **3.18.4** Registrar shall publish on its website a description of its procedures for the receipt, handling, and tracking of abuse reports. Registrar shall document its receipt of and response to all such reports. Registrar shall maintain the records ... for the shorter of two (2) years or the longest period permitted by applicable law ...

Notes: "prompt" has no fixed clock. "Actionable evidence" is undefined in the amendment (ICANN advisory reads it as enough readily available info for a reasonable determination; secondary source). The 24h review in 3.18.3 applies only to designated authorities, not private reporters. Escalation wording should cite 3.18.1 (confirmation, investigate) and 3.18.2 (mitigate), and state phishing = DNS Abuse per SAC115.

## 3. EU DSA Article 16 / 17

Source (verified, official OJ text L 277/1, 27.10.2022): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065. Applies to hosting service providers offering services in the EU (not only EU-established), not to registrars/CDNs strictly as "hosting" unless they store content.

**Art. 16(2)** — notice mechanisms must enable notices containing all of:
> (a) a sufficiently substantiated explanation of the reasons why the individual or entity alleges the information in question to be illegal content;
> (b) a clear indication of the exact electronic location of that information, such as the exact URL or URLs, and, where necessary, additional information enabling the identification of the illegal content adapted to the type of content and to the specific type of hosting service;
> (c) the name and email address of the individual or entity submitting the notice, except in the case of information considered to involve one of the offences referred to in Articles 3 to 7 of Directive 2011/93/EU;
> (d) a statement confirming the bona fide belief of the individual or entity submitting the notice that the information and allegations contained therein are accurate and complete.

**16(3):** a notice meeting this "give[s] rise to actual knowledge or awareness for the purposes of Article 6 ... where they allow a diligent provider of hosting services to identify the illegality of the relevant activity or information without a detailed legal examination." (Art. 6 liability exemption is lost if the provider does not act expeditiously.)

**16(4):** provider shall "without undue delay, send a confirmation of receipt".
**16(5):** provider shall "without undue delay, notify that individual or entity of its decision ..., providing information on the possibilities for redress".
**16(6):** providers "shall process any notices ... and take their decisions ... in a timely, diligent, non-arbitrary and objective manner"; automated means must be disclosed in the 16(5) notification.

**Art. 17(1)-(3):** the provider must give the affected recipient (site owner) a statement of reasons for removal/disabling/demotion/suspension, incl. whether it was based on a 16 notice and, where strictly necessary, the notifier's identity (17(3)(b)); legal ground and explanation (17(3)(d)); redress options (17(3)(f)). Not required for "deceptive high-volume commercial content" (17(2)). Consequence for us: the notifier identity may be disclosed to the site owner: use a role address, not personal details.

### Draft wording for an escalation notice

> Subject: Notice under Article 16 Regulation (EU) 2022/2065 – phishing content at hxxps://example[.]com/login (please confirm receipt)
>
> This is a notice under Article 16 of Regulation (EU) 2022/2065 (Digital Services Act).
>
> 1. **Reasons (Art. 16(2)(a)):** The URL(s) below host a phishing page that impersonates <BRAND> and collects <credentials/payment data> from visitors. This is fraud (deception to obtain data/money) and unlawful under <applicable law, e.g. national fraud/computer-misuse provisions>; it also infringes <BRAND>'s trademark. Evidence: screenshot (attached, captured <UTC timestamp>), HTTP headers, form action target <URL>, DNS/WHOIS and hosting data (IP <ip>, AS<asn>).
> 2. **Exact location (Art. 16(2)(b)):** <full URL list, one per line>; IP <ip>.
> 3. **Notifier (Art. 16(2)(c)):** <name/organisation>, <email>.
> 4. **Statement (Art. 16(2)(d)):** I confirm my bona fide belief that the information and allegations in this notice are accurate and complete.
>
> Under Art. 16(3) this notice gives rise to actual knowledge of the illegal content. Please (i) confirm receipt without undue delay (Art. 16(4)), (ii) disable access to the URL(s) expeditiously, and (iii) notify us of your decision and the available redress (Art. 16(5)), processed in a timely, diligent, non-arbitrary and objective manner (Art. 16(6)).

## 4. RIPEstat Data API

Base `https://stat.ripe.net/data/<call>/data.json`. Responses wrap in `{messages, see_also, version, data_call_name, data_call_status, cached, query_id, process_time, server_id, build_version, status, status_code, time, data:{…}}`. Docs: https://stat.ripe.net/docs/data-api/api-endpoints/asn-neighbours/ and .../abuse-contact-finder/ (verified). Live responses captured 2026-11-27. Use `sourceapp=<name>` parameter per RIPEstat usage guidance (https://stat.ripe.net/docs/data-api/ripestat-data-api/; not fetched this session).

### (a) asn-neighbours

`GET /data/asn-neighbours/data.json?resource=AS24940[&query_time=ISO8601]` (current version 3.2; older 4.1 selectable via `&version=`? not verified).

Live fields (AS24940):
```json
"data": {
  "resource": "24940",
  "query_starttime": "...", "query_endtime": "...", "latest_time": "...", "earliest_time": "...",
  "neighbour_counts": {"left": 111, "right": 36, "unique": 259, "uncertain": 147},
  "neighbours": [
    {"asn": 1031, "type": "left", "power": 89, "v4_peers": 299, "v6_peers": 0},
    {"asn": 12389, "type": "left", "power": 1, "v4_peers": 2, "v6_peers": 0}
  ]
}
```
- Path: `data.neighbours[].{asn,type,power,v4_peers,v6_peers}`; counts at `data.neighbour_counts`.
- `type`: "left" / "right" / "uncertain". Docs: "left" and "right" "refer to the position in the AS path with respect to the queried ASN". RIS AS paths read collector→origin, so **left = closer to the collector = the queried AS's upstream (provider/transit) side; right = downstream/customer side**. The docs do not use the words upstream/downstream: this mapping is derived from path order. "uncertain" = seen as left neighbour only as a direct RIS collector peer (RIS peering may create it): treat with caution/exclude. `power` = number of AS paths containing the pair: rank upstreams by `power` desc (also `v4_peers`).
- Version 4.1 renames `type`→`position` and adds `path_count`, `peer_count`.
- Also: `asn-neighbours-history`, `announced-prefixes` (prefixes of an ASN), `prefix-overview`/`network-info` (IP→prefix+ASN: `data.asns`, `data.prefix`).

### (b) abuse-contact-finder

`GET /data/abuse-contact-finder/data.json?resource=<ASN|prefix|IP>` (version 2.1). Docs warn: "this information is in many cases incorrect or not available".

Live:
```json
// resource=24940
"data": {"abuse_contacts": ["abuse@hetzner.com"], "authoritative_rir": "ripe",
  "latest_time": "2026-11-26T09:02:09", "earliest_time": "2026-11-26T09:02:09",
  "parameters": {"resource": "24940", "cache": null}}
// resource=1.1.1.0/24
"data": {"abuse_contacts": ["helpdesk@apnic.net"], "authoritative_rir": "apnic", ...}
```
- Path: `data.abuse_contacts[]` (may be empty), `data.authoritative_rir`. Works for non-RIPE resources (APNIC returned a generic RIR mailbox: e.g. `helpdesk@apnic.net` for 1.1.1.0/24 is the RIR, not the network: treat RIR addresses as low-confidence and skip).

## 5. Brand abuse contacts and security.txt

**RFC 9116** (verified, https://www.rfc-editor.org/rfc/rfc9116, published 2022-04): file at `/.well-known/security.txt` ("MUST place the "security.txt" file under the "/.well-known/" path"; legacy top-level `/security.txt` allowed, `/.well-known/` wins; HTTPS only). `Contact` is required: "This field MUST always be present"; ABNF `contact-field = "Contact" fs SP uri`; value is `mailto:`, `tel:` or `https://` URI; multiple entries ordered by preference. **It is for vulnerability reports, not phishing.** Verified examples: PayPal `Contact: https://hackerone.com/paypal` (https://www.paypal.com/.well-known/security.txt); Microsoft `Contact: https://msrc.microsoft.com/report/vulnerability/new` (https://www.microsoft.com/.well-known/security.txt). Neither is a phishing mailbox: do not use security.txt as the phishing channel; at best fallback after brand mailboxes.

| Brand | Phishing mailbox | Source | Status |
|---|---|---|---|
| PayPal | phishing@paypal.com | https://www.paypal.com/us/security/report-suspicious-activity ("forward the entire email to phishing@paypal.com"; same for SMS) | Verified. `spoof@paypal.com` not on that page: legacy, don't use. |
| Apple | reportphishing@apple.com | https://support.apple.com/en-us/102568 (page dated 2026-06-15) | Verified. Emails and SMS screenshots. |
| Amazon | stop-spoofing@amazon.com | https://aws.amazon.com/security/report-suspicious-emails/ ; form https://support.aws.amazon.com/#/contacts/report-abuse | Verified. Amazon retail help page was not fetchable (blocked). `reportascam@amazon.com` only on third-party blog: ignore. |
| Netflix | phishing@netflix.com | https://help.netflix.com/en/node/65674 | Verified. Also accepts links of fake sites/apps/phone numbers by email. |
| DHL | phishing@dhl.com | https://www.dhl.com/global-en/home/footer/fraud-awareness.html ("dedicated Anti-Abuse Mailbox"; email as attachment with headers; URLs/screenshots) | Verified. No reply to personal inquiries. `abuse@dhl.com` not confirmed. |
| Microsoft | phish@office365.microsoft.com (reported only) | https://support.microsoft.com/en-US/security/protect-yourself-from-phishing (search summary: attach phishing message to new mail; not forward) | Not confirmed by direct fetch (fetch returned a different Learn page). Learn page https://learn.microsoft.com/en-us/defender-office-365/submissions-outlook-report-messages (updated 2026-07-03) lists no address, only the Outlook Report button; Defender page lists `phishing-report@us-cert.gov` under APWG (legacy). Tech-support scams: https://msrc.microsoft.com/report/. Low confidence: use only as best-effort; `reportphishing@microsoft.com` reported to bounce. |
| Banks | none verified | – | Each bank publishes its own; no generic mailbox. Resolve per brand via the bank's security page (not researched). |

## Summary: most reliable channel per escalation step

1. **Hoster/ISP abuse mailbox:** RIPEstat `abuse-contact-finder` (prefix first, ASN fallback; drop RIR-level addresses) plus the host's own abuse page. Hardest-hitting, no wait period.
2. **Registrar:** abuse contact from ICANN Lookup / RDAP. RAA 3.18.1/3.18.2 obliges confirmation + prompt mitigation of phishing; cite them. Keep the sent copy as evidence.
3. **ICANN Compliance (gTLD only):** web form https://www.icann.org/compliance/complaint after a "reasonable time" (no defined days; suggest ≥ 3-5 business days), on a different day than the registrar report, with the registrar correspondence attached. Not for ccTLD or hosting.
4. **Upstream provider (RIPEstat `asn-neighbours`, `type: "left"`, highest `power`, skip `uncertain`):** abuse contact of that ASN via `abuse-contact-finder`; use for bulletproof hosters.
5. **DSA Art. 16 notice:** use the §3 template when the host serves EU users; gives legal hook (actual knowledge, Art. 6) and a duty to confirm and decide.
6. **Brand mailbox:** PayPal, Apple, Amazon, Netflix, DHL verified; Microsoft low confidence. Highest takedown speed for brand-owned reporting programs.
7. **CERT cc:** automated-intake mailboxes first (CERT.at `reports@`, CSIRT.CZ `abuse@`, CERT.br `cert@` cc, antiphishing.ch `reports@`, CERT.LV, CERT-Bund via hoster notifications). Government-focused teams (CERT-FR, CERT-Bund, GovCERT.*, NCCCI) give little value for third-party reports. GB/US/CA/JP/SG/HK/PL prefer forms: use web forms where mail is not the stated channel.
8. **Blocklists in parallel:** APWG `reportphishing@apwg.org` (verified), Google Safe Browsing / Microsoft SmartScreen web forms (not researched here).

Open items: UK NCSC email, Microsoft phish@ address, CN `cncert@` vs `cncert_report@`, RO current address, per-bank mailboxes, CISA mailbox on official page.
