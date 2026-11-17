# Multi-country coordination of phishing investigations: what a private non-profit can do

Date: 2026-11-17

Question: one phishing campaign touches several countries at once: Germany (victims, the reporter, ZCB Bamberg) plus the countries of the hoster, CDN, registrar and exfiltration endpoint. How can a private, non-commercial organisation help start such investigations, keep feeding them and keep them coordinated over time, without being an authority?

This report builds on [criminal-referral-routes.md](criminal-referral-routes.md). That report covers national intake routes, APWG/Chainabuse/Shadowserver/NCFTA as feeds, provider preservation and the follow-the-money channels, and this one does not repeat them. Here the focus is the layer above: the international coordination bodies, how real multi-country phishing operations were run, the formats police consume, how a case stays alive, and the legal limits.

Markers:

- **[unverified]**: the claim is not confirmed on a primary page (it comes from a secondary source or a search summary).
- **Assessment**: my own judgement of effort or benefit. It is not a sourced fact.

## Summary

1. **Coordination is an authority's job by law, and a private party plugs in through one national case.** Europol may process personal data from a private party only to find the competent national units. It must forward the data to them and erase it if none is found (Regulation (EU) 2016/794, Art. 26(2)). Eurojust's regulation has no basis for receiving data from private parties at all (Regulation (EU) 2018/1727, Art. 47). JIT members are authorities; NGOs and experts "generally" are not members. For phishing.support this means: one anchor case in Germany (ZCB Bamberg or BKA/ZIT), and that case's authority takes it to Europol, Eurojust or a foreign country. phishing.support makes that step cheap with country-by-country annexes.
2. **Every PhaaS takedown since 2022 had the same shape:** a private party tracked one kit for months, handed a structured dossier to one authority, and that authority ran the international part.
   - Tycoon2FA: Trend Micro → Europol EC3, then Advisory Groups and CIEP.
   - Kratos: Trend Micro → BKA, from 2025 to July 2026.
   - LabHost: led by the Met, with Europol involved from Sept 2023.
   - 16shop: an Interpol analyst project, then a criminal intelligence report to Indonesia.

   Lead times from first tracking to the action were 1.5 to 2.5 years. In the press releases, Eurojust appears in the malware operation Endgame but not in the PhaaS cases.
3. **The only precedent for a volunteer non-profit inside a Europol operation is DIVD** (a Dutch foundation run by volunteers). Police hand it seized data from Operation Endgame so it can notify victims, on a legitimate-interest basis. The bodies that start cases are large vendors (Microsoft, Trend Micro, Proofpoint, Intel 471). Non-profits (Shadowserver, abuse.ch, Spamhaus) support the disruption phase.
4. **Formal doors a small non-profit can actually open now:**
   - Europol's **EC3 Advisory Group on Research and Development** has an open call. It names NGOs, and applications are due **6 Dec 2026**.
   - **Interpol's Cybercrime Knowledge Exchange** takes join requests from private entities.
   - **FIRST** Associate (non-profit, $1,000/yr) or Individual ($100/yr) membership needs one sponsor and gives access to FIRST's MISP.
   - The **BSI Allianz für Cyber-Sicherheit** is free for German institutions.

   CIEP, the three original EC3 Advisory Groups, the Interpol Gateway, NCFTA and the MISP-LEA community are in practice closed to an operator of this size.
5. **Formats:**
   - Police intelligence systems run on MISP. Europol's Threat Intelligence Platform is an extended MISP, and MISP-LEA is the law-enforcement community run by CIRCL.
   - MISP exports STIX 2.1.
   - For a German case, what counts is an evidence package plus an index the investigator can read: CSV or TXT for IPs with timestamps, hashes, original files. I found no German authority that publishes a machine format for private submitters.
   - Exporting each campaign as a MISP event, as STIX 2.1, and as the existing evidence ZIP covers both worlds.
6. **Risks that shape the design:**
   - **Disclosure to foreign police:** GDPR Art. 49 makes direct, repeated transfers of personal data to police outside the EU hard to justify. Route them through the German authority, which can pass information spontaneously under Budapest Convention Art. 26.
   - **Timestamps:** the timestamps in the code come from DigiCert and FreeTSA. They are not eIDAS qualified **[unverified]**, so they lack the cross-border presumption of eIDAS Art. 41(2).
   - **Tipping off:** reporting the upstream infrastructure (panel, exfil endpoint, payment receiver) of a cluster that has an open case can burn a police operation. Coordinate with the case officer before reporting it.

## 1. Official entry points for private parties into international coordination

### Overview

| Entry point | What it is | Who may join | Open to phishing.support today? | Assessment: effort / benefit |
|---|---|---|---|---|
| Europol CIEP | Private experts work temporarily inside EC3 on specific projects | Selected companies; invitation-based **[unverified]** | No | — |
| EC3 Advisory Groups (Internet Security, Financial Services, Communication Providers) | Trusted industry network; can suggest cases and join operations | Companies; members appointed in a personal capacity | Unlikely | High / high |
| EC3 Advisory Group on Research & Development | Forum for research, R&D and knowledge sharing | Universities, research bodies, **NGOs**, public entities in the EU/Schengen | **Yes, call open until 6 Dec 2026** | Low / medium (relationship, not operations) |
| Europol Cyber Intelligence Gateway | Single entry point for intelligence from non-law-enforcement parties | Private parties; personal data must route via national units **[unverified]** | Unclear | Medium / unclear |
| Eurojust | Judicial coordination (coordination meetings, coordination centres, JITs) | Authorities only | No | — |
| Interpol Gateway | Formal data-sharing agreements with companies | Companies with a signed agreement | No | — |
| Interpol Cybercrime Knowledge Exchange | Workspace for non-police operational information | Private entities on request | **Yes, on request** | Low / low–medium |
| NCFTA (US) | Non-profit where industry and the FBI sit together | Vetted organisations | Unlikely | High / medium |
| NCMEC CyberTipline (US) | Statutory clearing house routing tips to police worldwide | Model only (CSAM) | n/a | — |
| UK CiSP / i100 / NCA partnerships | NCSC sharing platform, secondments, NCA PPPs | UK organisations; CiSP may need a sponsor | Probably not | — |
| BKA private-partner cooperation (G4C) | Association of banks with BKA/BSI | Members (banks, vendors) | No | — |
| Initiative Wirtschaftsschutz | Federal–industry association format | Authorities + business associations | No | — |
| BSI Allianz für Cyber-Sicherheit | Information-sharing network | German institutions, free | **Yes, if a legal entity** | Low / low (prevention, not prosecution) |
| FIRST | Global CSIRT forum with a MISP instance | Associates (non-profit rate) and individuals, one sponsor | **Yes** | Low–medium / medium (trust network, MISP) |

### 1.1 Europol CIEP (Cyber Intelligence Extension Programme)

- **What it is:**
  - Europol's own description: CIEP is a "pilot initiative" led by EC3 that "brings experts from the private sector into Europol HQ in The Hague to temporarily work side by side on specific projects with EC3 analysts and experts" (https://www.europol.europa.eu/about-europol/european-cybercrime-centre-ec3/cyber-intelligence-extension-programme-ciep, updated 19 Jun 2026).
  - Stated added value: European-level disruption, **"operational deconfliction"**, and timely intelligence sharing with Member States (same page).
  - Microsoft was "one of the CIEP's first partners" (same page).
  - In Tycoon2FA, Microsoft and Trend Micro worked through CIEP (https://www.europol.europa.eu/media-press/newsroom/news/global-phishing-service-platform-taken-down-in-coordinated-public-private-action).
- **Eligibility:**
  - No published criteria or application route. Europol's page names none.
  - A trade outlet says mnemonic "was invited" (https://www.dutchitchannel.nl/news/718851/mnemonic-neemt-deel-aan-europol-programma-voor-bestrijding-cybercriminaliteit), so participation looks invitation-based **[unverified]**.
  - Known participants: Microsoft, Trend Micro, ESET (per ESET's own press release), mnemonic.
  - The Europol Programming Document 2026–2028 says CIEP is still a pilot to be evaluated "with both law-enforcement and non-law-enforcement organisations", and that EC3 should explore it for joint J-CAT/private-sector initiatives (pp. 75, 80, https://www.europol.europa.eu/cms/sites/default/files/documents/Europol_Programming_Document_2026-2028.PDF).
- **NGOs, non-profits, individuals:** none known. I found no evidence of non-company participants.
- **What phishing.support would need:** an analyst to send to The Hague, a track record on a kit Europol cares about, and an invitation.
- **Assessment:** not reachable for a one-person operator. It is reachable indirectly, by feeding a CIEP vendor (Trend Micro, Microsoft) whose kit tracking overlaps phishing.support's clusters.

### 1.2 EC3 Advisory Groups

- **What they are:**
  - "More than 80 trusted private companies divided into three Advisory Groups" (Internet Security, Financial Services, Communication Providers). Activities include "suggestion of specific cases", "operational cooperation on cases affecting a specific industry" and "intelligence-sharing in a trusted community" (https://www.europol.europa.eu/sites/default/files/documents/ec3_brochure-advisory_groups.pdf, undated).
  - A May 2025 Europol slide counts 23 / 26 / 28 members (https://ripe90.ripe.net/wp-content/uploads/presentations/11-Europol-EC3-IOVINI-Emanuele-RIPE90-presentation-13-May-2025.pdf).
  - Statewatch counts four groups and "around a hundred industry leaders" (https://statewatch.org/analyses/2025/behind-closed-doors-europol-s-opaque-relations-with-tech-companies/).
- **Operational relevance:** in Tycoon2FA, Europol "disseminated this information through its EC3 Advisory Groups and operational networks … A number of Advisory Group members were subsequently brought into the investigation" (Europol press release, 4 Mar 2026, URL above). Advisory Groups are therefore a real route by which a dossier becomes a multi-country operation.
- **Membership (2013 call, the only one found):**
  - "up to 12 members appointed in their personal capacity"
  - at least five years of experience
  - CV plus model application form
  - two-year renewable term
  - confidentiality under the terms of reference

  Source: https://www.europol.europa.eu/sites/default/files/documents/call_for_expression_of_interest_ag_on_internet_security.pdf. Calls are periodic. I found no open call for the three original groups.
- **Members found:**
  - Self-declared: ESET, Proofpoint, Northwave, Palo Alto Networks, PRODAFT **[unverified]**.
  - Shadowserver, abuse.ch and Spamhaus appear as operational partners but **not confirmed** as Advisory Group members.
- **Assessment:**
  - **Effort:** high. It needs a track record and a vacancy.
  - **Benefit:** high. Members can suggest cases.
  - **Fit:** not realistic until phishing.support has a documented takedown contribution.

### 1.3 EC3 Advisory Group on Research and Development (AGRD), the open door

- **What it is:** an advisory group to "identify and promote research and development projects … and to provide a forum for knowledge sharing, research and innovation" (https://www.europol.europa.eu/work-with-us/other-opportunities/call-members-ec3-agrd, updated 10 Nov 2026).
- **Who may join:**
  - "This call is open to participants representing public or private universities, research institutions/centres, **NGOs** and/or other public entities, based in European Union Member-States or Schengen Associated Countries" (same page).
  - Applications go through an online form, due **6 December 2026, 23:59 CET**.
  - Whether members are appointed in a personal capacity is not confirmed for this group **[unverified]**. The call PDF was not readable.
- **What phishing.support would need:**
  - an NGO identity, probably at least a registered association (e.V.). A one-person private service may not count as "representing an NGO" **[unverified]**.
  - a short description of its research: kit fingerprinting, exfiltration-endpoint clustering, open data on campaigns.
- **Assessment:**
  - **Effort:** low, one application.
  - **Benefit:** medium. It is a research forum, not an operational channel, but it gives named contacts inside EC3. Those contacts are what turns a later dossier from cold mail into a known sender.
  - **Related:** Europol "Industry and Research Days" lets research bodies apply to present (https://www.europol.europa.eu/sites/default/files/documents/IndResearchDays_2026_ApplicationToPresent.pdf; the 2026 edition is past, so watch for 2027).

### 1.4 Europol's legal frame for private parties, and the Cyber Intelligence Gateway

**Europol Regulation (EU) 2016/794 as amended by 2022/991** (https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02016R0794-20220628):

- **Art. 2(f):** "private parties" expressly include non-profit organisations established under Member State law.
- **Art. 26(2)** (direct receipt): if Europol receives personal data directly from a private party, it may process it only to identify the national units concerned. It must forward the data to them "immediately", and must **erase** it if no unit is identified, unless a unit resubmits it within four months.
- **Art. 26(5) and (6a):** transfers back to private parties are case by case, strictly necessary, and "not systematic, massive or structural".
- **Art. 26(6b):** Europol may ask Member States to obtain data from private parties on their territory.
- **Meaning:** Europol is a router to national police, not a case owner for private submissions. The Europol/Eurojust *Common Challenges in Cybercrime 2024* report calls private-to-LE sharing a "'one-way street'" for legal reasons (pp. 20–21, https://www.europol.europa.eu/cms/sites/default/files/documents/Common_Challenges_in_Cybercrime_2024.pdf).

**Cyber Intelligence Gateway (CIG):**

- The 2026–2028 programming document says the EC3 CIG is to become "the single entry point for intelligence from non-law-enforcement parties", focused on operational and tactical matters (pp. 6, 75; URL above).
- Statewatch reports that it was "newly launched" in 2025, and that personal data "must be routed through national government 'contact units'" (URL above) **[unverified on a Europol page]**.
- I found no public CIG intake page, eligibility rules or format.

**Europol strategy:**

- Europol adopted its first "Strategy on cooperation with private parties, **including NGOs and academia**" in 2025 (Consolidated Annual Activity Report 2025, https://www.europol.europa.eu/cms/sites/default/files/documents/Consolidated-Annual-Activity-Report-2025.PDF, via search summary **[unverified]**).
- The 2026–2028 programming document names "phishing-as-a-service platforms" and "cooperating with the private sector, regulators and CSIRTs" under action A.4.6 (pp. 78–79).
- The full text of the strategy was not found.

**Assessment:** a direct submission to Europol from phishing.support would at best be forwarded to the BKA. That is exactly where a German Strafanzeige lands anyway. The CIG becomes relevant only once Europol publishes how non-LE parties may use it. Ask EC3 (via the AGRD contact form) whether it accepts NGOs and in what format.

### 1.5 Eurojust

- **No basis for private parties:**
  - Regulation (EU) 2018/1727 lists only authorities and EU bodies as information sources (Art. 2(1)).
  - Working arrangements and direct exchange are limited to EU bodies, third-country authorities and international organisations (Art. 47(1)–(4)). "Private parties" are not mentioned (https://www.eurojust.europa.eu/sites/default/files/AboutUs/EULegalframework/2018-11-21_Eurojust-Regulation_2018-1727_EN.pdf).
- **Planned change:**
  - A 2026 Commission proposal would let Eurojust exchange operational personal data with "relevant private parties". The EDPS notes that, unlike the Europol Regulation, it does not define them (EDPS Opinion 19/2026, https://www.edps.europa.eu/system/files/2026-08/26-08-11_opinion_eurojust_en.pdf; proposal COM(2026) 570).
  - It is a proposal only, not law.
- **Eurojust's own view:** "no standardised rules of engagement exist" with the private sector (https://www.eurojust.europa.eu/crime-types-and-cases/crime-types/cybercrime).
- **Why it still matters:** see §4.3, the Art. 21(5) duty that a well-built dossier can trigger.

### 1.6 Interpol

- **Gateway:** a framework for sharing cyber threat intelligence with "trusted private partners", through formal agreements under Art. 28 of Interpol's Rules on the Processing of Data. The partners are companies such as Group-IB, Trend Micro and Kaspersky (https://www.interpol.int/en/Resources/INTERPOL-Spotlight/Spotlight-Issue-2-Cybercrime/Spotlight-Cybercrime-Outreach; https://www.unodc.org/documents/Cybercrime/AdHocCommittee/Third_intersessional_consultation/Presentations/Panel_4_Pei_Ling_Lee_Interpol.pdf). No eligibility criteria are published.
- **Cybercrime Knowledge Exchange (CKE):**
  - "open to law enforcement, governments, international organizations and cybersecurity industry experts to exchange non-police operational information on cybercrime."
  - "International and private entities can request to join the CKE by contacting the INTERPOL Cybercrime Directorate" (https://www.interpol.int/Crimes/Cybercrime/Cybercrime-Collaboration-Services).
- **Cybercrime Collaborative Platform – Operations:** invitation only, for private partners "that INTERPOL has cooperation agreements with" (same page).
- **Assessment:** the CKE is a low-effort request that gives visibility to police cyber units outside the EU (Indonesia, Nigeria, Malaysia: the countries where the PhaaS arrests below happened). Benefit is uncertain, because it is a knowledge workspace, not a case channel.

### 1.7 US models: NCFTA and the CyberTipline

- **NCFTA:**
  - A 501(c)(3) non-profit formed in 2002. Members "co-locate with us and our law enforcement Members (in Pittsburgh, PA or New York City) or … engage remotely" (https://www.ncfta.net/become-a-partner).
  - Members come from "Fortune 500 companies … government agencies, and a select number of academic programs" (https://www.ncfta.net/).
  - No published fee or criteria.
  - **Assessment:** a vetted membership. It is out of reach for a German one-person service, and the existing report found no NCFTA role in European phishing cases.
- **NCMEC CyberTipline (model, not a route):**
  - US providers must report CSAM under 18 U.S.C. § 2258A. NCMEC must make every report available to law enforcement, routes each by jurisdiction, and tags it "actionable" or "informational". It works with police in about 160 countries, including Europol and Interpol (https://www.missingkids.org/content/dam/missingkids/pdfs/2023-CyberTipline-Report.pdf; https://www.missingkids.org/content/dam/missingkids/pdfs/OJJDP-NCMEC-Transparency-CY-2023-Report.pdf).
  - No equivalent exists for phishing. The model shows what makes a private clearing house useful to police across borders:
    - a legal mandate;
    - jurisdiction routing;
    - triage labels.

    phishing.support can copy the last two (per-country annexes and "actionable/informational" grading) but not the first.

### 1.8 UK

- **CiSP:** NCSC's sharing platform, free, re-launched with a new portal in March 2024 (https://x.com/NCSC/status/1763578196815991230).
  - Older terms required a UK-registered legal entity and a sponsor (https://archive.comsuregroup.com/wp-content/uploads/2017/10/Cyber-Security-Information-Sharing-Partnership-CiSP-NCSC-Site.pdf, 2016) **[unverified for 2026]**.
- **Industry 100:** a secondment scheme for company staff (https://www.ncsc.gov.uk/collection/ncsc-annual-review-2024/chapter-03).
- **NCA:** runs "Public Private Partnership initiatives" with financial, telecom, tech and cyber firms (https://www.nationalcrimeagency.gov.uk/news/fraud-strategy-supports-national-crime-agency-s-commitment-in-fight-against-fraud). A Home Office/NCA Online Crime Centre is to bring in private representatives (https://www.publictechnology.net/2026/03/13/public-order-justice-and-rights/home-office-and-ncs-to-lead-new-national-online-crime-centre/, secondary).
- **Assessment:** none of these is open to a German non-profit. The UK channel stays the NCSC mailbox described in the existing report.

### 1.9 Germany

- **BKA:**
  - The BKA says it cooperates "mit gemeinnützigen Vereinen wie G4C" (https://www.bka.de/DE/KarriereBeruf/ArbeitenBeimBKA/Einblicke/Cybercrime/cybercrime_node.html).
  - Its Forschungs- und Beratungsstelle Cybercrime is a contact point for research bodies in Germany and abroad (https://www.bka.de/DE/UnsereAufgaben/Forschung/ForschungsUndBeratungsstellen/Cybercrime/Cybercrime_node.html).
  - Endgame press releases praise "private IT-Sicherheitsunternehmen" without naming them (https://www.bka.de/DE/Presse/Listenseite_Pressemitteilungen/2026/Presse2026/261112_Endgame.html).
  - I found **no** BKA programme that admits outside organisations to operational work. The Kratos case shows the real mechanism: a vendor (Trend Micro) shared findings with the BKA "since 2025" (§2).
- **Initiative Wirtschaftsschutz:**
  - Partners are BfV, BKA, BND and BSI plus the associations BDI, DIHK, ASW and BDSW (https://www.wirtschaftsschutz.info/DE/Ansprechpartner/Initiative_WiS/ini_node.html).
  - It is open to new members "when needed", per the BMI strategy (https://www.bmi.bund.de/SharedDocs/downloads/DE/publikationen/themen/sicherheit/BMI26004-nationale-wirtschaftsschutzstrategie.pdf).
  - It protects companies against espionage and sabotage. It is not a cybercrime case channel, so it does not fit.
- **G4C:** covered in the existing report. It is a members-only association of banks.
- **Allianz für Cyber-Sicherheit (BSI):**
  - "Jede Institution (Unternehmen, Behörden etc.), die sich mit dem Thema Cybersicherheit beschäftigt, kann prinzipiell Teilnehmer … werden". It needs a named contact person and a confidentiality declaration, and "Die Teilnahme ist kostenlos" (https://www.allianz-fuer-cybersicherheit.de/Webs/ACS/DE/Ueber-uns/Teilnehmer/teilnehmer_node.html).
  - Since 2026, registration goes through the BSI portal with "Mein Unternehmenskonto" (https://www.allianz-fuer-cybersicherheit.de/Webs/ACS/DE/Home/_/infos/20260106_BSI-Portal.html).
  - Natural persons are not mentioned.
  - **Assessment:** easy to join if phishing.support is an e.V. or similar. It feeds the national situation picture and gives peers, not prosecutions.
- **ZAC Bayern** (Bavaria's central cybercrime contact point for organisations):
  - Its online form is for "Unternehmen, Behörden und sonstige Organisationen wie Vereine oder Verbände" in Bavaria that are themselves affected. Private persons are sent to the police IT hotline (https://www.zac-formular.polizei.bayern.de/).
  - phishing.support is a third-party reporter, not an affected organisation, so the form fits only partially.
  - ZCB Bamberg's address for prosecutors is cybercrime@gensta-ba.bayern.de (https://www.datenschutz-bayern.de/cyberabwehr/uebersicht.pdf, an old document) **[unverified as current]**.

### 1.10 Communities around the authorities

- **FIRST:**
  - Associates are "teams that are not in the security incident response business that have a legitimate interest". The non-profit Associate rate is $1,000/yr. Individual members pay $100/yr. Both need one sponsor, and both get access to FIRST's MISP instance, Slack and mailing lists (https://www.first.org/membership/).
  - **Assessment:** this is the cheapest way into the trusted community where the vendors, CERTs and some police cyber units meet. The sponsor is the real hurdle.
- **CiviCERT:** lists a MISP community of providers, NGOs "and individuals" (https://www.misp-project.org/communities/). It is aimed at civil-society security, so it is a weak fit.
- **DIVD (precedent):**
  - DIVD is a private foundation run by volunteers. It receives seized data from the Dutch police in Operation Endgame and notifies victims on a "legitimate interest" basis. It works "independently, without any obligation or intention to share specific information in return" (https://www.divd.nl/faq/faq-operation-endgame/).
  - The Dutch police and Europol name it in press releases (same page).
  - This is the closest model of a volunteer non-profit with a defined role in a multi-country operation. Its role sits **after** the action (victim notification), not in starting the case.

## 2. How multi-country phishing/PhaaS actions were actually coordinated

| Case | Who started it | Coordinator | Private role | Time from first tracking to action | Primary source |
|---|---|---|---|---|---|
| **Tycoon2FA** (4 Mar 2026) | "The investigation began after intelligence was shared by Trend Micro" | Europol EC3 as "central hub between private partners and investigators"; police action in LV, LT, PT, PL, ES, UK. No Eurojust or JIT mentioned | Microsoft led the technical disruption; Trend Micro and Microsoft worked via CIEP; Cloudflare, Coinbase, Intel 471, Proofpoint, Shadowserver and SpyCloud were "engaged through Europol". No arrests announced | Kit active since Aug 2023; investigation start not published | https://www.europol.europa.eu/media-press/newsroom/news/global-phishing-service-platform-taken-down-in-coordinated-public-private-action |
| **Kratos / Sneaky2FA** (20 Jul 2026, "Olympus Blade") | Trend Micro tracked the kit from Dec 2024 and shared "methodologies for fingerprinting Kratos infrastructure … victimology and regular infrastructure updates" with the BKA from 2025 | ZIT Frankfurt + BKA with US authorities; arrest in Indonesia. No Europol or Eurojust named in sources read | Trend Micro: intelligence only | About 19 months (Dec 2024 to Jul 2026) | https://www.trendmicro.com/en_us/research/26/g/kratos-takedown.html; BKA release https://www.bka.de/DE/Presse/Listenseite_Pressemitteilungen/2026/Presse2026/260720_PM_Kratos.html (not fetchable; content via search summaries **[unverified]**) |
| **LabHost** (14–17 Apr 2024) | Cyber Defence Alliance intelligence to the Met, June 2022 (existing report, secondary) | "led by the UK's London Metropolitan Police, with the support of Europol's EC3 and the J-CAT"; Europol involved "since September 2023"; "an operational sprint was organised at its headquarters with all the countries involved"; 19 countries | The Europol release names none; Intel 471, Chainalysis, Microsoft, Shadowserver and Trend Micro per secondary sources | About 22 months (Jun 2022 to Apr 2024) | https://www.europol.europa.eu/media-press/newsroom/news/international-investigation-disrupts-phishing-service-platform-labhost |
| **16shop** (announced 8 Aug 2023) | "flagged by analysts in INTERPOL's cybercrime division during an ongoing project" on ASEAN threats, supported by the Japanese NPA | Interpol: a criminal intelligence report to Indonesian police; US servers handled via NCB Washington and the FBI; NPA Japan and INP shared directly | Cyber Defense Institute, Group-IB, Unit 42, Trend Micro, Cybertoolbelt helped locate the administrator | Early 2021 to Jul/Aug 2023 (Interpol conference report, via search summary **[unverified]**) | https://www.interpol.int/en/News-and-Events/News/2023/Notorious-phishing-platform-shut-down-arrests-in-international-police-operation |
| **RaccoonO365** | Microsoft DCU + Cloudflare civil seizure of 338 domains (Sept 2025) | Microsoft via the FBI to Nigeria Police (NCCC), with US Secret Service; arrests Sept–Oct 2025, announced Dec 2025 | Microsoft supplied the intelligence | Weeks after the civil action | Secondary only: https://therecord.media/nigeria-raccoon-developer-tip; police post https://x.com/PoliceNG/status/2001681791325753763 **[unverified]** |
| **BulletProofLink** | Microsoft public report Sept 2021; OSINT researcher 2020 | Royal Malaysia Police with AFP and FBI; 8 arrests Nov 2023 | Intelligence | About 2 years | Secondary only: https://www.bleepingcomputer.com/news/security/police-takes-down-bulletproftlink-large-scale-phishing-provider/ **[unverified]** |
| **Lighthouse / Darcula** | Google civil suits (Nov/Dec 2025) | Civil courts, SDNY; no criminal coordination found | Google as plaintiff | n/a | https://cyberscoop.com/lighthouse-text-scammers-disrupted-google-lawsuit/ (secondary) |
| **Operation Endgame** (malware, not phishing; template for German-led cases) | German lead (ZIT/BKA) since 2024 | **Eurojust coordination centre "to manage simultaneous actions in all countries concerned" and "five coordination meetings"** (May 2024); Europol support; Nov 2026 phase with NL, DK, UK, US, CA | Unnamed "private IT-Sicherheitsdienstleister"; BSI sinkholing; DIVD victim notification | Continuous programme since 2024 | https://www.eurojust.europa.eu/news/major-operation-take-down-dangerous-malware-systems; https://www.bka.de/DE/Presse/Listenseite_Pressemitteilungen/2026/Presse2026/261112_Endgame.html |

**Patterns:**

1. **One case owner, many executors.**
   - In every criminal case one national authority (the Met, ZIT/BKA, Indonesian INP, Malaysian RMP) owned the case.
   - Europol (Tycoon2FA, LabHost), Interpol (16shop) or a direct bilateral link (Kratos DE–US) carried it to the other countries.
   - Eurojust appears where judicial instruments (EAW, EIO, MLA) had to be synchronised for an action day (Endgame). It does not appear in any PhaaS press release found.
2. **The private trigger was sustained tracking, not a snapshot.** Trend Micro on Kratos: "Sustained tracking of a kit's infrastructure and its generational changes over time is what makes it possible to hand law enforcement something they can act on, rather than a single snapshot" (Trend Micro URL above). That matches phishing.support's cluster model exactly. What it lacks is the case owner.
3. **The upstream countries mattered more than the victim country.** Arrests happened where the operator lived (Indonesia, Nigeria, Malaysia, UK) and seizures where the servers were. The hoster and registrar countries supplied data; the operator's country made the arrests.
4. **Lead times are long.** From first tracking to action took about 1.5–2.5 years in the cases with dates. A coordination tool must keep a cluster's evidence alive and appendable for that long.
5. **Civil actions are fast but rarely end in arrests.** RaccoonO365 is the exception, through Microsoft's FBI referral.

## 3. Formats police actually consume

| Format | Who uses it | Can phishing.support use it? | Assessment |
|---|---|---|---|
| **SIENA** (Europol's secure messaging) | Authorities; used for "cross-checking operational data … deconfliction, and coordination" (RIPE90 Europol slides, URL above) | No | It is the channel the German case officer uses to take phishing.support's data abroad |
| **MISP** | Europol's Threat Intelligence Platform (ETIP) extends MISP to "threat intelligence, financial fraud information …" (Programming Document 2026–2028, p. 75 fn.); MISP-LEA is the police community run by CIRCL | Yes, as a format; also MISPPRIV/FIRST communities | **Best machine format**: police analysts can import a MISP event directly |
| **MISP-LEA community** | "MISP-LEA welcomes law enforcement agencies that are vetted by the MISP-LEA consortium" (https://misp-lea.org/join/); "only accessible to law enforcement agencies" (https://www.misp-project.org/communities/) | No | Indirect only: a police unit can import phishing.support's events |
| **CIRCL MISPPRIV** | "mainly targeting private organizations, companies, financial organizations or IT security companies", more than 1,100 members (https://www.misp-project.org/communities/) | Probably, if accepted. CIRCL says access is "free but subject to validation" (https://circl.lu/services/misp-malware-information-sharing-platform/) | Low effort; reaches CERTs and vendors, not police directly |
| **STIX 2.1 / TAXII 2.1** | MISP exports STIX 2.1 via misp-stix. As of release 2026.11.12, MISP content sits in "MISP's own STIX extension definitions" (https://www.misp-project.org/2026/11/16/misp-stix.2026.11.12.released.html/) | Yes | Produce it by converting from MISP, not as a separate model |
| **Evidence package** (files + manifest + hashes + timestamps) | German police and courts | Already exists (`src/lib/evidence/package.ts`, `src/lib/referral/archive.ts`) | The format for the case file itself |
| **Large File Exchange, Virtual Command Post** | Europol tools for authorities (RIPE90 slides; JIT guide recommends LFE for bulk data) | No | — |

**What German authorities ask for:**

- Schleswig-Holstein's LKA cybercrime form asks for original mails ("keine Weiterleitungen") and log files, and says IP addresses should be stored with timestamp and port, e.g. as .txt or .csv (https://www.schleswig-holstein.de/DE/landesregierung/ministerien-behoerden/POLIZEI/DasSindWir/LKA/cybercrime/_artikel/_downloads/formular_anzeigenerstattung.pdf?__blob=publicationFile&v=5, via search summary **[unverified]**).
- I found no German police page that names MISP, STIX or a hash format for private submitters.
- At the BKA autumn conference (Nov 2026), investigators called for more and more standardised data-exchange formats, including across borders (heise report, https://www.heise.de/news/BKA-Herbsttagung-Kriminalaemter-fordern-mehr-Datenaustausch-gegen-Betrugswellen-11523346.html, via search summary **[unverified]**).

**Implication:** per campaign, ship three views of the same data:

1. the evidence ZIP (for the Akte);
2. a flat `indicators.csv` (URL, domain, IP, port, first/last seen in UTC, hoster, registrar, exfil endpoint, SHA-256 of the evidence file), readable by any investigator;
3. a MISP event JSON plus a STIX 2.1 bundle generated from it, for the analysts at BKA/Europol who import into ETIP or MISP-LEA.

## 4. Case continuity and cross-referencing across countries

### 4.1 Keeping one German case alive

- **Confirmation of receipt (§ 158(1) StPO):**
  - "Dem Verletzten ist auf Antrag der Eingang seiner Anzeige schriftlich zu bestätigen". The confirmation "kann versagt werden, soweit der Untersuchungszweck, auch in einem anderen Strafverfahren, gefährdet erscheint" (https://dejure.org/gesetze/StPO/158.html).
  - The right belongs to the *Verletzter* (the injured party). A third-party reporter like phishing.support has no statutory right to the confirmation and depends on the authority's practice.
- **Notice of closure (§ 171 StPO):**
  - If the prosecutor closes the case, "so hat sie den Antragsteller unter Angabe der Gründe zu bescheiden" (https://dejure.org/gesetze/StPO/171.html).
  - That is the formal feedback point. A closure under § 170(2) can be reopened on new leads (existing report).
- **Supplements under the case number:**
  - No statute governs a "Nachtrag" (supplementary submission). It is simply a further communication quoting the Aktenzeichen, and practice depends on the case officer.
  - The existing report already recommends automatic supplements. Agree them **once** by phone or e-mail with the officer: cadence, format, size limit, and whether he wants every new site or only new upstream indicators.
- **Collective proceedings across German prosecutors (RiStBV Nr. 25 ff.):**
  - Uniform investigations as a Sammelverfahren are "geboten" when offences touch the districts of several prosecutors or are connected (Nr. 25), and are conducted where the "Schwerpunkt" lies.
  - The Generalstaatsanwälte agree within about three days which office leads (https://www.anwalt24.de/gesetze/ristbv/25; https://www.bmjv.de/SharedDocs/Publikationen/DE/Fachpublikationen/2023_Richtlinien_Strafverfahren.pdf?__blob=publicationFile&v=1, via search summary **[unverified wording]**).
  - **Consequence:** if phishing.support's reports were filed in several Länder, telling each office about the others' case numbers is exactly the input Nr. 25–27 needs to merge them.

### 4.2 Cross-referencing case numbers across countries

- **How it works between authorities:**
  - National police cross-check through Europol (SIENA, the Europol Information System) and Interpol.
  - Spontaneous transfers go under Budapest Convention Art. 26: a Party may, "without prior request", forward information from its own investigations when it might help another Party start or carry out proceedings (Convention text https://www.europarl.europa.eu/meetdocs/2014_2019/documents/libe/dv/7_conv_budapest_/7_conv_budapest_en.pdf; T-CY Guidance Note on spontaneous information, 25 Jun 2025, https://www.coe.int/en/web/cybercrime/-/the-t-cy-adopts-a-new-guidance-note-on-spontaneous-information-).
  - Use of Art. 26 is uneven: some Parties use it very often, others rarely or never (same T-CY page).
- **What a private reporter knows:**
  - Only the references it received itself: a German Aktenzeichen, an NCSC or IC3 confirmation, a Chainabuse report ID, a provider's abuse ticket.
  - Foreign police case numbers normally stay with the police.
- **Is flagging "related case X in country Y" useful or harmful?**
  - **Useful** when sent **to the case officer**. The Europol/Eurojust report defines deconfliction as "avoiding that EU Member States and operational partners are targeting the same suspects and groups, without being aware of each other's investigations". Without it "entire investigations may be derailed", and lack of deconfliction is among the most common challenges for smaller single-country cases (*Common Challenges in Cybercrime 2024*, pp. 17–19, URL above).
  - A reporter-side map ("the same exfil bot ID also appears in our report to NCSC-UK, ref …; the panel is hosted at a Dutch hoster; the registrar is in the US") hands the officer the deconfliction query.
  - **Harmful** when published or sent to providers. Linking clusters publicly, or telling a hoster "this is part of investigation X", can reach the operators.
  - § 158(1) StPO itself lets police refuse a confirmation if it would endanger the investigation "auch in einem anderen Strafverfahren". The law expects information to flow one way during an investigation.
- **Assessment:** keep a per-campaign "references" list: own filings, provider tickets, and any foreign references received. Send it **only** in the case supplement. Never put law-enforcement references in provider reports, except the German Aktenzeichen in preservation requests, which the existing report already proposes.

### 4.3 Getting the German case to the international level

- **Eurojust Art. 21(5)** (https://www.eurojust.europa.eu/sites/default/files/AboutUs/EULegalframework/2018-11-21_Eurojust-Regulation_2018-1727_EN.pdf):
  - National authorities must inform their Eurojust national member "without undue delay" of a case that:
    - affects at least three Member States;
    - has judicial cooperation requests sent to at least two of them; and
    - concerns, among other categories, "computer crime" with a high enough maximum penalty, **or** shows indications of a criminal organisation or a serious cross-border dimension.
  - A phishing.support dossier cannot trigger this itself. But it can make the trigger obvious by stating, per campaign:
    - which Member States host infrastructure;
    - which data each country's provider holds (account, payment, logs);
    - which legal instrument would reach it (EIO, EPOC-PR under e-Evidence, MLA for non-EU).
- **Europol route:** the German case officer can send the data to Europol via SIENA. Europol's Art. 26 rules then apply between authorities, not to phishing.support.
- **Non-EU countries (US hoster, Indonesian operator):** Budapest Art. 26 spontaneous information, the 24/7 network, Interpol NCBs, or MLA. All of these are authority-to-authority.

## 5. Risks

### 5.1 Tipping off and deconfliction with police

- **Evidence:**
  - Europol lists "operational deconfliction" as a core purpose of bringing private partners inside (CIEP page).
  - In botnet takedowns, private actions have hurt other investigations. Researchers said Microsoft's Zeus takedown hurt other work, and the Honeynet Project's checklist asks whether an action "would jeopardize law enforcement investigations" (https://www.darkreading.com/cyberattacks-data-breaches/controversy-erupts-over-microsoft-s-recent-takedown-of-a-zeus-botnet, secondary).
  - Academic work found takedowns interfering with each other for lack of a central registry (https://astrolavos.gatech.edu/articles/rza-ccs2013.pdf).
  - I found no published deconfliction protocol for private reporters.
- **Assessment (design rule):**
  - Lure pages (victim-facing) keep being reported for takedown. Victim protection outweighs, and police actions in the cases above targeted panels, servers and operators, not lures.
  - Once a cluster has a case number, **upstream** reports (admin panel, collector host, exfiltration bot/webhook, payment receiver, kit seller's shop) are held and offered to the case officer first, with a deadline after which the default is to report.
  - This matches the existing report's advice on Telegram bots, and extends it to all upstream infrastructure.

### 5.2 Admissibility of privately captured evidence across borders

- **Germany:**
  - Evidence gathered by private persons is in principle usable, even if obtained unlawfully. Exceptions are narrow: attribution to the state, or violations of human dignity or the core of private life. LG Bochum, 2 Qs 10/08, citing BGH NJW 1978, 1390 and BGH NJW 1989, 2760 (https://www.hrr-strafrecht.de/hrr/lg/08/2-qs-10-08.php; the BGH decisions are not read in the original **[unverified]**).
  - phishing.support captures public web pages lawfully, so usability is not the issue. **Weight** is: the court assesses reliability.
- **Other countries:**
  - The JIT practical guide says admissibility is governed by national law and "is rarely challenged" (https://www.eurojust.europa.eu/sites/default/files/assets/joint_investigation_teams_practical_guide_2021_en.pdf, FAQ 2.12).
  - Switzerland, for comparison, admits unlawfully obtained private evidence only if the authorities could have obtained it lawfully (BGE 146 IV 226).
- **Reliability is the real gap.** Europol/Eurojust note that alternative sources such as "phishing data sets" have reliability and traceability that are "difficult to determine, potentially undermining their validity for judicial proceedings" (*Common Challenges 2024*, p. 9). The answer is a documented method:
  - capture tool and version;
  - vantage point (IP, country);
  - headless or real browser;
  - SHA-256 manifest;
  - independent timestamp;
  - unbroken chain from capture to export.
- **Timestamps:**
  - eIDAS Art. 41: a non-qualified electronic time stamp may not be denied legal effect merely for being electronic or non-qualified (41(1)). Only a **qualified** time stamp enjoys "the presumption of the accuracy of the date and the time it indicates and the integrity of the data" (41(2)), and it is recognised in every Member State (41(3)) (https://lexparency.org/eu/32014R0910/ART_41/).
  - `src/lib/evidence/timestamp.ts` uses DigiCert (`timestamp.digicert.com`) and FreeTSA. I could not confirm either as a qualified trust service on the EU Trusted List **[unverified]**; FreeTSA almost certainly is not.
  - **Assessment:** adding one qualified TSA from the EU Trusted List as a second token per manifest is a cheap way to gain the EU-wide presumption.

### 5.3 Data protection basis for sharing with foreign authorities

- **To German or EU authorities:**
  - GDPR Art. 6(1)(f). Recital 50 states that "indicating possible criminal acts or threats to public security by the controller" and transmitting the relevant data to a competent authority "should be regarded as being in the legitimate interest pursued by the controller", unless a secrecy obligation applies (https://gdpr-info.eu/recitals/no-50/).
  - § 24(1) Nr. 1 BDSG allows non-public bodies to process data for another purpose if "zur Verfolgung von Straftaten erforderlich", unless the data subject's interests prevail (https://dejure.org/gesetze/BDSG/24.html).
- **Art. 10 GDPR caveat:** processing data "relating to criminal convictions and offences" based on Art. 6(1) is allowed "only under the control of official authority or when … authorised by Union or Member State law providing for appropriate safeguards" (https://gdpr-info.eu/art-10-gdpr/). Whether reporter-side suspicion data about unknown operators falls under Art. 10, and whether § 24 BDSG is enough authorisation, is a legal question I could not settle from primary sources. Treat it as **open; get counsel**.
- **To authorities outside the EU (US, Indonesia, Nigeria):**
  - Chapter V GDPR applies.
  - Art. 49(1)(d) ("important reasons of public interest") needs that interest recognised in Union or Member State law. Art. 49(1)(e) covers legal claims, not police reporting.
  - The residual ground in Art. 49(1) subpara. 2 requires transfers that are "not repetitive", concern a "limited number of data subjects", come with notice to the supervisory authority and the data subject (https://gdpr-info.eu/art-49-gdpr/).
  - Continuous feeding of a foreign case fails that.
  - **Assessment:** send personal data abroad only through the German authority (Budapest Art. 26, MLA, Europol). Direct reports to foreign bodies (IC3, NCSC-UK) should carry indicators and evidence of infrastructure, not victims' personal data.
  - The UK has an EU adequacy decision (Statewatch, URL above, secondary), so NCSC-UK is a weaker concern.

### 5.4 Legal risk for the operator

- **False suspicion (§ 164 StGB):** it requires acting "wider besseres Wissen" (against better knowledge). Good-faith wrong reports are not punishable. Reckless or arbitrary complaints can create civil liability (https://stgb.de/paragraph/164-falsche-verdaechtigung/; https://www.ra-kotz.de/wann-besteht-ein-schadensersatzanspruch-wegen-falscher-verdaechtigung-164-stgb-vor.htm, secondary).
  - **Rule:** file against unknown persons ("gegen Unbekannt").
  - Mark hacked legitimate websites as victims, not suspects.
  - Correct the record when exculpatory facts appear.
- **Unauthorised access (§§ 202a, 202c StGB):** never log into panels or use harvested bot tokens. This is already in the existing report.
- **Confidentiality:** membership of Europol advisory groups, the ACS or FIRST comes with confidentiality terms (Europol 2013 call; the ACS Vertraulichkeitserklärung). Information received there must not flow into public campaign pages.

## Ranked best bets

| # | Action | What phishing.support provides or becomes | Assessment: effort | Assessment: expected benefit |
|---|---|---|---|---|
| 1 | **One anchor case per PhaaS-scale cluster** at ZCB Bamberg (or ZIT/BKA for national scale), with a standing supplement channel agreed with the officer | Dossier plus per-country annex (§4.3), references list, supplements under the Aktenzeichen | Medium (one human contact) | **High**: the only route by which data reaches Europol, Eurojust and foreign police lawfully and usefully |
| 2 | **Upstream hold rule** for clusters with an open case (§5.1) | A per-cluster flag and a deadline in the reporting pipeline | Low | High: avoids burning operations; makes phishing.support a partner police can trust |
| 3 | **Three export views per campaign**: evidence ZIP, `indicators.csv`, MISP event JSON plus STIX 2.1 bundle | Exporter code | Medium | High: matches what investigators, BKA/Europol analysts and CERTs import |
| 4 | **Apply to the EC3 Advisory Group on Research & Development by 6 Dec 2026** | NGO identity (an e.V. is probably needed), a research description | Low | Medium: named EC3 contacts; a later path toward CIEP vendors and Advisory Groups |
| 5 | **Feed a CIEP/Advisory Group vendor** whose tracking overlaps (Trend Micro for AiTM kits; Microsoft DCU for M365 kits) | Cluster data under a sharing agreement | Medium | Medium–high: this was the trigger for Tycoon2FA and Kratos |
| 6 | **Add a qualified eIDAS timestamp** next to the existing RFC 3161 tokens | A qualified TSA from the EU Trusted List (likely paid) | Low | Medium: EU-wide presumption of time and integrity |
| 7 | **FIRST** (non-profit Associate or Individual) and **CIRCL MISPPRIV** | Sponsor; validation | Low–medium | Medium: trust network and MISP distribution to CERTs and vendors |
| 8 | **Interpol CKE** join request | E-mail to the Cybercrime Directorate | Low | Low–medium: visibility to non-EU police units where operators get arrested |
| 9 | **BSI Allianz für Cyber-Sicherheit** | Legal entity, contact person, confidentiality declaration | Low | Low for prosecution; feeds the national situation picture |
| — | Not worth pursuing now | CIEP, the original three Advisory Groups, Interpol Gateway, NCFTA, MISP-LEA, CiSP, Initiative Wirtschaftsschutz, Eurojust directly | — | Closed or no fit |

## Open questions

1. **Legal form:** does the AGRD call (and Interpol CKE, FIRST, ACS) accept a one-person service, or is an e.V. or gGmbH needed? The AGRD call PDF was not readable. Read it before 6 Dec 2026.
2. **Europol Cyber Intelligence Gateway:** does it exist as a usable intake for NGOs, and in what format? There is no public page. Ask via the AGRD contact form.
3. **ZCB Bamberg:** will it accept the role of anchor case for multi-country clusters from a third-party reporter, and in what format and cadence for supplements? Is cybercrime@gensta-ba.bayern.de current?
4. **Art. 10 GDPR:** do § 24 BDSG and Recital 50 cover a non-profit that continuously processes and passes on suspicion data about unknown operators? This needs a lawyer.
5. **Timestamps:** are DigiCert's or FreeTSA's TSAs qualified under eIDAS? Which qualified TSA (e.g. a German one on the EU Trusted List) offers RFC 3161 at a non-profit-compatible price?
6. **Kratos origin:** read the BKA release itself (it was not fetchable here) to confirm the role of private partners and whether Europol or Eurojust were involved.
7. **Europol Strategy on Cooperation with Private Parties (2025):** its "dedicated approach for NGOs and academia" is not public. A request under Regulation 1049/2001 could obtain it.
8. **Deconfliction contact:** does any German authority offer private reporters a way to ask "is this infrastructure already under investigation?" I found none. The case officer is the only channel.
