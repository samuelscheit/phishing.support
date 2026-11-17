# Criminal referral and data preservation routes for phishing sites

Date: 2026-11-17

Question: which routes reliably get a criminal investigation opened for phishing sites phishing.support finds, and how can providers be made to keep account, payment and log data after a takedown so police can obtain it? Germany first, but any jurisdiction that works.

The five detailed reports with every source are in the appendix. This section is the synthesis.

## Findings

### 1. Single phishing sites do not get investigated; actor clusters do

Every phishing case that ended in arrests between 2022 and 2026 started from one structured package about one kit or one operator, not from many single reports:

- **LabHost:** the bank-funded Cyber Defence Alliance handed intelligence to the Met in June 2022. Result: 37 arrests.
- **Tycoon2FA (March 2026):** started when Trend Micro shared a dossier with Europol EC3.
- **BulletProofLink:** started from Microsoft research.
- **16shop:** Group-IB and Trend Micro worked with Interpol.
- **Kratos (July 2026):** run by the BKA with ZIT Frankfurt.

German statistics point the same way. The BKA reports a clearance rate of about 2 % for cybercrime committed from abroad. A single site with an unknown operator ends in closure under § 170 (2) StPO.

What police can act on are the **links between sites**:

- the same kit fingerprint
- the same exfiltration endpoint (Telegram bot ID or chat ID, Discord webhook, collector host)
- the same payment receiver (IBAN, wallet, merchant ID)
- the same origin IP

phishing.support already collects all of these: `abuse/origin/siblings.ts`, `exfiltration/*`, and RFC 3161 evidence manifests.

### 2. No public route turns a bulk third-party feed into a criminal case

Each intake falls into one of these patterns:

| Route | Who may file | Mechanism | Outcome |
|---|---|---|---|
| Onlinewache (DE Länder) | anyone, with full identity | web form, no API | case number by mail, single incident |
| E-mail Strafanzeige to Staatsanwaltschaft or police (§ 158 StPO, no form required) | anyone; a named complainant gets a case number and feedback | e-mail | **case number**; the legality principle (§ 152 StPO) forces a review |
| ZAC at the LKAs | companies and authorities, not private persons | e-mail/phone | human contact point |
| ZIT Frankfurt / BKA | no public intake | relationship | runs PhaaS-scale cases (Kratos) |
| FBI IC3 | victims or people filing for them; identity under 18 USC 1001 | form, no attachments, no feedback | intelligence for RAT/field offices |
| UK Report Fraud (Action Fraud's successor since 12/2025) | victims | form | victim case |
| NCSC-UK `report@phishing.gov.uk` | anyone, no identity | e-mail, automatable | takedown, shared with NCA/CoLP as intelligence |
| Swiss BACS `reports@antiphishing.ch` | anyone | e-mail | takedown, blocking of `.ch` |
| Europol / Interpol | no public intake | via national police or vendor partnerships (EC3 advisory groups, CIEP) | — |
| APWG eCX | members; a Researcher Data Grant for NGOs and research | REST API (`/phish`) | indicator exchange that law enforcement can read; no case |
| Chainabuse (TRM) | anyone, API key; opt-in contact by law enforcement | REST API, batch | law-enforcement tier sees reports; wallets only |
| Brand fraud teams (PayPal `phishing@paypal.com`, DHL `phishing@dhl.com`, Amazon `stop-spoofing@amazon.com`) | anyone | e-mail | takedown; brands file criminal complaints as the injured party, internally |
| G4C (banks with BKA/BSI), Cyber Defence Alliance, NCFTA | members only | — | origin of LabHost |
| BSI Meldestelle, Verbraucherzentrale Phishing-Radar | anyone | e-mail | no investigation |

### 3. Reliable means a named complainant plus a case number plus supplements

The only route that gives an automated tool a **case number** and a legal duty to review is a written Strafanzeige from a named natural person to a Staatsanwaltschaft or to police cybercrime. In Germany that can be a plain e-mail: § 158 (1) StPO requires no form, and the offences are prosecuted ex officio (§§ 263a, 269, 202a ff. StGB, § 143 MarkenG). Once a case number exists, every new site that matches the same cluster can be sent as a supplement to the same case. That turns one closed single case into a growing investigation file, which is the pattern prosecutors act on.

Above that sit **relationships**, which are a human step but the documented origin of real cases:

- a named contact at a Schwerpunktstaatsanwaltschaft or LKA cybercrime unit
- ZIT/BKA for clusters of PhaaS scale
- security vendors with law-enforcement pipelines (Trend Micro, Microsoft DCU for M365 kits, Intel 471, Proofpoint)
- the fraud teams of the brand that was hit

### 4. Preservation: only authorities can compel it; a private reporter can ask and prepare

- **Binding instruments** are for authorities only:
  - US 18 USC 2703(f): 90 + 90 days.
  - EU e-Evidence European Preservation Order: in force since 2026-08-18, 60 + 30 days, sent by prosecutors through e-CODEX.
  - Budapest Convention Art. 16 and 29, through the 24/7 network.
  - The German Sicherungsanordnung (BT-Drs. 21/6581) is **not in force** and would cover only telecom traffic data. Today German hosters are reached only through §§ 94/95 StPO and the TDDDG.
- **Provider practice:**

  | Provider | Formal preservation | Data kept after takedown |
  |---|---|---|
  | DigitalOcean | 90 + 90 days, account data | droplet content purged at deletion |
  | GitHub | 90 days | — |
  | Google LERS | preservation form | — |
  | Hostinger | explicit preservation process for law enforcement | customer data deleted 30 days after termination; account record kept up to 1 year after a safety suspension |
  | Cloudflare | — | keeps almost no end-user data |
  | Hetzner | answers only German and Finnish authorities | — |
  | Telegram | only on a judicial order (IP and phone since 09/2024, about 900 US requests in Q4 2024) | — |
  | Registrars | — | ICANN RAA keeps registrant data for the term + 2 years, so it survives a takedown |

  **Hosting logs and content are what get lost.**
- No provider documents a voluntary preservation request from a non-law-enforcement reporter. Asking costs nothing, however, and a request that quotes a case number gives the provider a lawful reason (GDPR Art. 6 (1)(f)) to suspend instead of purge.
- **Conflict:** reporting an exfiltration channel immediately (for example a Telegram bot) can destroy the evidence police would request. Banning it protects the next victims.

### 5. Implications for phishing.support

1. Report campaigns, not sites. Cluster submissions by the shared indicators that already exist.
2. Send one dossier per campaign as an e-mail Strafanzeige from a named complainant, get the case number from the reply, then send supplements automatically.
3. Ask for suspension instead of purge in every takedown report from now on. Once a case number exists, send each provider of the campaign a preservation notice quoting it, and give the investigator a request template per provider.
4. Feed the machine-readable channels that law enforcement or the industry actually read: Chainabuse for wallets, APWG eCX after joining, NCSC-UK and brand mailboxes for takedown and intelligence.
5. Escalate PhaaS-scale clusters by hand to ZIT/BKA and the vendors with Europol pipelines.

## Open points (verify before building)

- Current Telegram abuse address (`abuse@telegram.org` is not confirmed by a primary source).
- APWG eCX eligibility and fees for a private operator or open-source project.
- Preservation practice at GoDaddy, Vercel, Netlify, IONOS, Contabo, Wix and Squarespace (their law-enforcement pages render only with JavaScript).
- Which Staatsanwaltschaft or police cybercrime unit accepts a standing supplement channel by e-mail (this needs one human first contact).

## Appendix: detailed reports

The five reports below were researched in parallel on 2026-11-17. Each states its own verification caveats.

### Germany

### German routes for criminal reports and data preservation (status 2026-11-16)

Most of what follows comes from search summaries. I did not open the BKA, DIP or law-text pages myself except where a URL is cited as the source. Items marked **[unverified]** need a primary-source check before you build on them.

### 1. Länder Onlinewachen

- **Who may submit:** Anyone can file a Strafanzeige. Under §158(1) StPO a third party or witness may report; the victim need not be the one filing (https://www.online-strafanzeige.de/info is only a lawyer guide). I found no explicit rule on third-party filing in the portals themselves.
- **Identity:** Forms ask for name, address, date of birth and phone. BundID login is optional in Thüringen (https://thueringen-digital.de/aktuelles/onlinewache). A formal complaint is not anonymous, because without personal data there is no case number or feedback (https://amtsdeutschland.de/polizei/onlinewache/, a secondary source).
- **Mechanism:** Web forms, Land by Land. I found no API or bulk feed, and the portals can be assumed to be captcha-protected **[unverified]**. Which Land is competent is fuzzy for pure internet crime. You can usually choose your own Land.
- **Feedback:** A Vorgangsnummer comes back by email. After that the Land hands the case to the local Kripo or a cybercrime unit.
- **Evidence of effect:** None phishing-specific. The BKA reported 1,425 phishing cases passed up from the Länder in 2017 (https://www.bka.de/SharedDocs/Downloads/DE/Publikationen/JahresberichteUndLagebilder/Cybercrime/cybercrimeBundeslagebild2017.pdf?__blob=publicationFile&v=3), which is old.
- **Limits:** Designed for one victim and one incident. A tool filing many reports through the portals would likely be rate-limited or treated as abuse, and the operator would have to put their own name and birth date on each filing.

### 2. Zentrale Ansprechstellen Cybercrime (ZAC) at the LKAs

- **Target group:** Companies, authorities and associations, and explicitly **not private individuals** (https://www.lka.polizei-nds.de/kriminalitaet/deliktsbereiche/internetkriminalitaet/zentrale-ansprechstelle-cybercrime-zac-515.html; that page is old).
- **Contacts found:**
  - BW: cybercrime@polizei.bwl.de
  - Berlin: zac@polizei.berlin.de
  - Bremen: cybercrime@polizei.bremen.de
  - MV: cybercrime.lka@polmv.de
  - Niedersachsen: zac@lka.polizei.niedersachsen.de
  - RLP: zac@polizei.rlp.de
  - Saarland: cybercrime@polizei.slpol.de
  - Sachsen: zac.lka@polizei.sachsen.de
  - Thüringen: cybercrime.lka@polizei.thueringen.de
  - The list is aggregated at https://www.schwerin.de/politik-verwaltung/dienstleistungen/verwaltungsleistungen/Zentrale-Ansprechstelle-Cybercrime-ZAC-Dienststelle-fuer-die-Wirtschaft-kontaktieren/. Bayern, Hamburg, Hessen and NRW were not retrieved. The official overview is https://www.polizei.de/Polizei/DE/Einrichtungen/ZAC, which I did not fetch.
- **Researchers and NGOs:** I found no stated policy that accepts them. A private operator is not the target group. Best case, it is a human contact point for escalating a pattern, such as a serial campaign with many German victims or German-hosted infrastructure.
- **Limits:** Email and phone only, no API, and they are not a case-intake system.

### 3. Prosecution centres (ZIT, Schwerpunkt-StA, LKA/BKA)

- **ZIT, Generalstaatsanwaltschaft Frankfurt:** I found no public tip channel for private parties. It takes big cases with the BKA.
  - Kratos phishing-as-a-service: July 2026, the developer was arrested in Indonesia, and it ran as a Telegram shop. https://www.bka.de/SharedDocs/Kurzmeldungen/DE/Kurzmeldungen/260720_Schlag_gegen_Phishing_Gruppierung_Kratos.html, https://www.presseportal.de/blaulicht/pm/7/6318131
  - Operation Endgame, per a third-party blog: https://shattered.io/de/operation-endgame-gootloader-castlerat-stealc-bka-zugangsdaten **[unverified]**
  - ZIT head's 2023 statement (CSAM tips, about 75% "success", the rest closed for lack of leads): https://kripoz.de/wp-content/uploads/2023/10/Stellungnahme-Krause.pdf
- **Other Schwerpunkt-StA** (ZAC NRW Köln, ZCB Bamberg, LKA BW): I did not research them. They act on Anzeigen and referrals from police, not on researcher feeds.
- **BKA:** It collects reports from the Länder and runs phishing-as-a-service operations. I found no public tip form for researchers. Realistic path: an LKA or BKA Cybercrime contact reached through a prior relationship.
- **Pattern:** Prosecutors act on bundled, infrastructure-level dossiers (a kit, a PhaaS operator, a payment receiver), not single phishing sites. That favours dossiers that cluster by operator or infrastructure.

### 4. G4C

- **Status:** The "German Competence Centre against Cyber Crime e.V." was founded by Commerzbank, ING-DiBa and HypoVereinsbank in 2013. It signed a BKA cooperation agreement in 2014 (https://www.bka.de/DE/Presse/Listenseite_Pressemitteilungen/2014/Presse2014/140121_Unterzeichnung_Kooperationsvertrag.html). Members were banks, Schufa, security vendors, and BKA/BSI as partners.
- **Current state unclear:** The latest primary artefact is a 2020 press release. A 2026 press release describes a new "German Center for CyberSecurity e.V." (GC4C), launched 2025 and not identical to G4C (https://www.presseprisma.de/2026/08/german-center-for-cybersecurity-e-v-offizieller-launch-eines-umfassenden-nationalen-cybersecurity-ecosystems/).
- **Can outsiders feed it?** It is a closed membership association of firms. I found no external intake. Membership would be a company decision, not something a private person can obtain **[unverified]**.

### 5. BSI / CERT-Bund

- **Scope:** It takes reports on phishing sites and incidents, but it is **not a law-enforcement body**. Its FAQ says the Meldestelle "has no mandate for offender investigation", and it advises notifying the provider directly for German-hosted phishing (https://www.allianz-fuer-cybersicherheit.de/Webs/ACS/DE/IT-Sicherheitsvorfall/Unternehmen/Haeufig-gestellte-Fragen/hauefig-gestellte-fragen_node.html; the page is old). Contact meldestelle@bsi.bund.de.
- **Feedback:** Anonymous reports are possible. Individual feedback is not routine.
- **Value:** Low for criminal investigation. Possibly useful as an additional nudge to German providers, and for CERT-Bund's own notification of ISP abuse desks.

### 6. Verbraucherzentrale Phishing-Radar

- **Scope:** It takes forwarded phishing mails at phishing@verbraucherzentrale.nrw and publishes warnings. It does **not forward to the police** (https://www.verbraucherzentrale.de/wissen/digitale-welt/phishingradar/phishingmails-woran-sie-sie-erkennen-und-worauf-sie-achten-muessen-6073). Volumes were 382k mails in 2025 (https://www.verbraucherzentrale.nrw/pressemitteilungen/manipuliert-und-abgezockt-mehr-schutz-vor-finanzbetrug-im-internet-118246).
- **Value:** Warning only, no investigation.

### 7. Legal form and realistic outcomes

**Form of the complaint**
- A Strafanzeige under §158(1) StPO is formless. A plain email without signature or qualified signature is valid, and even an anonymous tip is a valid Anzeige (https://www.anwalt.de/rechtstipps/strafanzeige-und-strafantrag-unterschied-form-und-fristen-286597.html, secondary).
- The §158(2) Strafantrag changed in 2024. Schriftform was replaced by "identity and will to prosecute assured", and whether a plain email suffices is disputed (https://www.haufe.de/recht/weitere-rechtsgebiete/strafrecht-oeffentl-recht/digitalisierung-der-justiz-digitale-strafantraege_204_629476.html).
- Phishing (§§263a, 202a-c, 269 StGB) is offered ex officio, so Strafantrag is not needed.

**Legality principle (§152(2) StPO)**
- With an Anfangsverdacht the authorities must investigate. Emailing a well-evidenced Anzeige to a Staatsanwaltschaft or Polizeipräsidium is legally sufficient. In practice an email without a named complainant may only get a Tagebuchnummer.

**Outcomes**
- The BKA Bundeslagebild 2025 reports an inland clearance rate of about 31% and a foreign-offence clearance rate of 2.0% (https://www.security-insider.de/bka-bundeslagebild-cybercrime-2025-ransomware-loesegeld-a-d6b7c82a963e014c07472141500f36de/, secondary; primary PDF https://www.bka.de/SharedDocs/Downloads/DE/Publikationen/JahresberichteUndLagebilder/Cybercrime/cybercrimeBundeslagebild2025.pdf).
- Phishing-specific closure rates were not found.
- Unknown perpetrators usually lead to a §170(2) StPO closure, which carries no Strafklageverbrauch. Cases reopen on new leads (https://staatsanwaltschaft-karlsruhe.justiz-bw.de/pb/,Lde/1267844).
- §154 StPO and case bundling by Staatsanwaltschaften are practice knowledge, and I found no source for them.
- Concrete German phishing cases found: Kratos (ZIT/BKA, 2026), Leipzig SMS-phishing (four suspects, at least €33k damage, https://www.medienservice.sachsen.de/medien/news/1073501), and the Berlin spoofing platform (https://www.berlin.de/polizei/polizeimeldungen/2026/pressemitteilung.1724968.php). Not found: a German case driven specifically by a Telegram bot token.

### 8. Data preservation tools

- **§§94/95 StPO:** Seizure and a production duty. A formal seizure needs a judge, or the prosecutor in case of imminent danger. They apply to data (https://www.bundestag.de/resource/blob/891984/WD-7-024-22-pdf.pdf). They require an open investigation and an order, so they cannot be triggered by a private party.
- **§100j StPO:** Bestandsdaten requests, aimed at telecommunication providers. Whether hosters fall under it is **[unverified]**.
- **TDDDG §§22-24:** These are the provider-side legal basis for information requests. §22 covers Bestandsdaten and §24 Nutzungsdaten, the latter requiring a named legal basis and form, and §23 passwords (https://dejure.org/gesetze/TDDDG/24.html). They allow disclosure and do not oblige preservation.
- **Quick-Freeze/Sicherungsanordnung, BT-Drs. 21/6581:**
  - Introduced 19.06.2026, first reading 24.06.2026, committee hearing 7.10.2026.
  - A Beschlussempfehlung was not found, so the bill is **not in force** (https://dip.bundestag.de/vorgang/gesetz-zur-einf%C3%BChrung-einer-ip-adressspeicherung-und-weiterentwicklung-der-befugnisse-zur/334474).
  - It targets traffic and location data held by telecom providers, 3 months plus 3 months. The government rejected extending it to all data categories (https://dserver.bundestag.de/btd/21/071/2107154.pdf).
  - Not relevant to hosters or payment data.
- **My own judgement, not sourced:** Today the only practical lever on a hoster is a voluntary preservation request. A German-operated hoster that receives a credible police case number (Aktenzeichen) can lawfully retain, and an abuse report should say "please do not delete, a criminal complaint is pending under reference X."

### Best bets for an automated tool

1. **Email Anzeige bundled per operator or campaign to the competent Staatsanwaltschaft or LKA Cybercrime unit.** Include a structured dossier covering the kit fingerprint, exfil endpoints and hoster. It is legally valid under §158(1), and the operator should sign it as a named complainant. This is the only route likely to yield an Aktenzeichen.
2. **Ask LKA ZACs for a named contact, then send pre-agreed dossiers.** It is manual and human-mediated, but the realistic way to get past §170(2) closures.
3. **Cite the Aktenzeichen in abuse and preservation requests to hosters.** This is the only available preservation lever until a Sicherungsanordnung is enacted.
4. **Onlinewache per Land, for victim-assisted filing only.** Do not bulk automate.
5. **BSI Meldestelle and the Verbraucherzentrale Phishing-Radar.** These are optional signalling channels with no investigative effect.
6. **G4C/GC4C.** Pursue only if a bank partner sponsors a membership.

---

### International LE intake

### International law-enforcement intake routes for a third-party researcher

**Overall finding:** I found no international police route with a public API or bulk feed for phishing reports. The only documented machine-friendly intakes are the NCSC-UK mailbox and the Swiss `reports@antiphishing.ch` mailbox, and both lead to takedown or intelligence, not cases. Every channel that opens cases is victim-oriented and needs a human, or a bilateral relationship with a police unit. Search snippets and page summaries were my main input. Anything marked "unverified" I did not confirm on a primary page.

### 1. FBI IC3 (US)

- **Who may submit:** Victims, or someone filing "on behalf of another person you believe has been affected". People abroad and reports about foreign subjects are accepted. A pure non-victim researcher is not clearly covered ([FAQ](https://www.ic3.gov/Home/FAQ)).
- **Identity:** The form asks for complainant name, address, phone and email. It requires an accuracy attestation under 18 U.S.C. § 1001. Anonymous filing is not mentioned. A third party would have to put a victim in the complainant fields, which is awkward and risky for a tool.
- **Mechanism:** Web form only. No attachments, no API, no bulk route, and the FAQ says there is no spam-forwarding address. A bulk or API option may exist for partners, but I found no public documentation.
- **Feedback:** None. The FAQ says "You will not hear from the IC3", and the only copy of the complaint is the one you save at submission. Complaints are forwarded to federal, state, local or international agencies "as appropriate".
- **Case evidence:** IC3 data feeds the Recovery Asset Team (RAT) and Operation Level Up. The [2025 IC3 report](https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf) says the RAT has worked with banks and field offices since 2018 to freeze funds. The 2025 figures I saw ($679m frozen, 58% success rate) come from a secondary source and are unverified. Operation Level Up (launched January 2024) has notified more than 8,000 victims, per that report. Both are victim- and fund-centric. Neither is a takedown or infrastructure pipeline.
- **Other FBI channel:** [tips.fbi.gov](https://tips.fbi.gov/violation-selection) tells cyber-enabled crime reporters to use IC3.
- **Limits:** The FBI does not announce that a given report was acted on, and there is no documented researcher-referral path to IC3.

### 2. UK: Report Fraud and NCSC SERS

- **Report Fraud:** It replaced Action Fraud for England, Wales and Northern Ireland, going live on 4 December 2025 with a full public launch in January 2026. It is run by City of London Police, and Scotland still goes through Police Scotland on 101 ([CoLP](https://www.cityoflondon.police.uk/news/city-of-london/news/2025/december/report-fraud-service-goes-live-with-full-public-launch-in-january-2026/)). It has a new backend analysis system (N-CAS) per [techUK](https://www.techuk.org/resource/report-fraud-service-replaces-action-fraud-as-uk-s-official-fraud-reporting-portal.html). I found no API or bulk route, and no third-party rules. It is a victim reporting service, so treat it as a human-only, victim-only route.
- **NCSC SERS (`report@phishing.gov.uk`):**
  - **Intake:** Anyone, anywhere, can forward "as many suspicious emails as you like". There is no identity requirement and no web form for emails. Emails with multiple links may bounce, and NCSC suggests one link per email or its suspicious-website form ([NCSC page](https://www.ncsc.gov.uk/collection/phishing-scams/report-scam-email)).
  - **Outcome:** It leads to analysis and takedown, not investigation. The page says NCSC "may work with hosting companies" to remove sites and cannot tell you the outcome. It also says it may share details with the NCA and City of London Police "to help identify investigation and mitigation opportunities", and that it is not a way to report a crime.
  - **Scale:** The overview page states 267.3k scams removed across 472,300 URLs, and the email page gives 454.8k URLs removed as of July 2026. These figures are inconsistent between pages. Both are takedown numbers, not arrests.
  - **Automation:** Forwarding by SMTP is trivially automatable. NCSC has not published a rate limit.
  - **Honest assessment:** This is the best low-friction, no-identity intake. Its value is takedown plus indirect intelligence to UK police. I found no concrete cases attributed to it.

### 3. Netherlands

- **Fraudehelpdesk:** NCSC-NL says phishing goes to the [Fraudehelpdesk](https://www.ncsc.nl/incidenten-en-herstellen/aangifte-melding-doen) (`verdacht@fraudehelpdesk.nl`, per a secondary source). It has no investigative powers and cannot take personal data of suspects ([NCSC-NL](https://www.ncsc.nl/phishing/sms-phishing-smishing)).
- **NCSC-NL:** It does not accept phishing reports.
- **Police:** Formal reports (aangifte) are by phone (0900-8844) or at a station. Online filing covers only payment-request fraud and bank-detail phishing ([politie.nl](https://www.politie.nl/informatie/ik-wil-aangifte-doen-van-phishing.html), an old page of roughly 4 years).
- **Verdict:** Victim-only, human-only. There is no documented police intake for a third-party researcher.

### 4. Switzerland

- **BACS/NCSC:** It takes phishing sites through antiphishing.ch and emails through `reports@antiphishing.ch`. A reply requires the form at report.ncsc.admin.ch. For `.ch` and `.swiss` domains it can have the site blocked directly ([BACS](https://www.bacs.admin.ch/en/phishing-en)). This is a takedown route, not a criminal one.
- **cybercrimepolice.ch (Kantonspolizei Zürich, for all of Switzerland):** It takes tips on new scam methods only. Criminal complaints must be filed at a local police station or through Suisse ePolice ([cybercrimepolice.ch](https://cybercrimepolice.ch/de/ereignis-melden)). A researcher could use it for a trend or modus-operandi tip, but not to open a case.
- **Not verified:** whether these tips reach prosecutors.

### 5. Europol EC3 and Interpol

- **Europol:** The official [Report a crime](https://www.europol.europa.eu/report-a-crime) page says to contact local or national police, who will involve Europol if needed. Its [FAQ](https://www.europol.europa.eu/faq/if-i-know-about-crime-committed-or-criminal-action-in-preparation-should-i-contact-europol) (about 10 years old) says Europol cannot arrest or investigate on citizen information. Third-party guides claim an online Europol tip tool exists. I did not confirm that on europol.europa.eu, so it is unverified.
- **Interpol:** I found no public reporting route. Only a third-party blog says victims cannot report directly to Interpol.
- **Realistic Europol/Interpol contact:** Only through a national police unit, or through Europol's industry partnerships. I found nothing public on how to join those, so ask Europol EC3 directly.

### 6. FTC ReportFraud and Consumer Sentinel (US)

- **Sentinel access:** Only law enforcement can read it, not non-government contributors ([Data Book 2022](https://www.ftc.gov/system/files/ftc_gov/pdf/CSN-Data-Book-2022.pdf)). About 3,000 federal, state, local and international users have access, per a 2025 event listing.
- **Data contributors:** The [data contributors page](https://www.ftc.gov/enforcement/consumer-sentinel-network/data-contributors) lists IC3, Microsoft, MoneyGram, AARP and state attorneys general. Contributors are mostly organisations with their own complaint flows. Whether a security project could become one is unverified. Contact sentinel@ftc.gov (an address from older FTC material).
- **Retention:** Reports are kept five years (2020 data page).
- **Bulk or API for the public:** I found none.
- **Verdict:** It is a long-lived intelligence repository that gets viewed by investigators, not a case-opening route. Filing is cheap, but each report is a manual form.

### 7. US Secret Service

- **Intake:** Public reporting is via [field offices](https://www.secretservice.gov/contact/field-offices), most of which have a Cyber Fraud Task Force. It has no public online tip form that I found.
- **Global Investigative Operations Center (GIOC):** It does analysis and has seized nearly $400m of digital assets over about a decade ([Fortune](https://fortune.com/crypto/2025/07/05/secret-service-global-enforcement-crypto-scams-asset-seizures/)). Field offices run the investigations.
- **Verdict:** Relationship-based. A phishing campaign with US victims and a payment trail could be handed to a field office by a person, not by a tool.

### Not covered

EU e-Evidence, preservation-request mechanics (Budapest Convention Art. 16, 24/7 network) and German routes are outside my topic. Preservation orders can only come from police, so this research does not show any way for the tool to trigger them directly.

### Ranked best bets for an automated tool

1. **NCSC-UK `report@phishing.gov.uk`.** Open to anyone, no identity needed, plain email, automatable, with a stated link to NCA and City of London Police intelligence. It gives takedown and indirect intelligence, but no case number and no feedback.
2. **Swiss `reports@antiphishing.ch`.** Same shape as NCSC-UK, and it can block `.ch` and `.swiss` domains directly. It is takedown only.
3. **Direct police-unit relationship, by hand.** For each campaign with strong evidence, such as an exfiltration endpoint or payment receiver, send a single curated package to a named cybercrime unit. Use the US Secret Service Cyber Fraud Task Force or an FBI field office for US-hosted infrastructure. These are manual and a human must sign off, but they are the only routes that can open a case.
4. **FTC Consumer Sentinel data-contributor status.** It needs a bilateral agreement, which is unverified for a private researcher. It may be the only route to put bulk data in front of investigators.
5. **IC3 web form.** Use only for individual high-value cases, with a real victim as complainant. It cannot be automated and gives no feedback.
6. **Fraudehelpdesk (NL), cybercrimepolice.ch, Europol and Interpol.** Low value or no route for a third party.

**Core limitation:** No route I found turns a bulk, third-party feed into a criminal case. For a tool, takedown mailboxes plus curated human-reviewed packages to specific police units is the realistic design.

---

### Industry-LE sharing networks

### Industry ↔ law-enforcement data-sharing routes for phishing.support

**Caveat.** I used search summaries and one fetched article (The Register on Kratos). I did not verify most primary pages directly. Treat "primary" below as "the cited page says so", not as independently checked.

### Main finding: what makes police pick up phishing cases

In the cases I found, the trigger was never a mass of individual abuse reports. It was a trusted, structured intelligence package about one kit or service operator: the operator's identity, payment flows, infrastructure and customer base. It came from one of three places:

- **Bank or industry consortium.** LabHost began in June 2022 when the Cyber Defence Alliance, a membership group of financial-sector organisations, passed intelligence to the Met. The Met's operation (STARGREW) ran almost two years. It was joined by NCA, City of London Police and regional units, then Europol from Sept 2023. Sources: https://www.computerweekly.com/news/366581453/International-police-operation-infiltrates-LabHost-phishing-website-used-by-thousands-of-criminals and https://www.intel471.com/blog/cybercrime-takedowns-trust-partnerships-and-focus.
  - Intel 471 had tracked LabHost actors since 2021 and handed over forums, shops and Telegram groups.
  - Chainalysis, Microsoft, Shadowserver and Trend Micro were named partners.
  - Result: 37 arrests, about 70 premises searched, and about 480k card numbers seized.
  - "Operation Stronghold" did not appear in any source; the UK name was STARGREW.
- **A security vendor's dossier.**
  - Tycoon2FA (4 March 2026): Europol says the case began when Trend Micro shared information, which Europol routed through EC3 advisory groups. Source: https://www.trendaisecurity.com/en-us/resources-insights/trendai-security-blog/tycoon2fa-takedown. Proofpoint, Intel 471 and eSentire added telemetry. Coinbase traced funds. Microsoft obtained an SDNY order, and Cloudflare handled infrastructure outside US jurisdiction. Shadowserver notified more than 200 CERTs. Police actions were in LV, LT, PT, PL, ES and the UK. Source: https://www.shadowserver.org/news/tycoon-2fa-phishing-as-a-service-disruption/. Microsoft says it was its first coordination under Europol's Cyber Intelligence Extension Programme (https://securitybrief.com.au/story/microsoft-europol-disrupt-global-tycoon-2fa-scam).
  - BulletProofLink: Microsoft found it in Sept 2021. Malaysian police, with AFP and FBI, arrested 8 people in Nov 2023 (https://securityaffairs.com/154041/cyber-crime/bulletproftlink-phaas-platform-seized.html).
  - 16shop: Group-IB and Trend Micro worked with Interpol. The operator was arrested in Indonesia in Feb 2022, two more arrests followed, and Interpol announced it in Aug 2023 (https://www.group-ib.com/top-investigations/phishing-store-shutdown/). The announcement came about 18 months after the first arrest.
- **A national police unit with its own cybercrime remit.**
  - Kratos (BKA and ZIT Frankfurt, press release 20 July 2026): more than 200 servers, and the developer/admin arrested in Indonesia with US support. Source: https://www.theregister.com/security/2026/07/21/german-authorities-lead-takedown-of-kratos-phishing-platform/5275666.
  - The sources I read do not say how it started or name private partners. Microsoft, KnowBe4 and others published research on it beforehand. The BKA release and ZIT statement should be checked.
  - Belgian federal police and Europol arrested a phishing-panel supplier in April 2026 (https://www.police.be/shape/en/news/crime-service-phishing-panel-supplier-arrested).

**Civil action is not criminal.**

- RaccoonO365: Microsoft DCU and Cloudflare seized 338 domains on a SDNY order in Sept 2025. Microsoft named a Nigerian national as leader and "referred" him to international law enforcement (https://www.theregister.com/2025/09/16/microsoft_cloudflare_shut_down_raccoono365/). I found no arrest.
- Google v. Lighthouse (Nov 2025, RICO/CFAA/Lanham Act, 25 John Does, SDNY) and Google v. Darcula (Dec 2025; injunction April 2026, about 300 domains) are civil. Sources: https://thehackernews.com/2025/11/google-sues-china-based-hackers-behind.html and https://ampyxcyber.com/newsarchive/google-disrupts-darcula-scam-network-behind-millions-of-fake-delivery-texts.
- Singapore police arrested Darcula-linked people (several arrests reported 2024 to 2026). I found no evidence of a Netcraft-driven police case.
- Robin Banks: no arrest found. The operators moved infrastructure after exposure.
- iServer: Europol/EC3 supported 17 arrests in Spain and Latin America. The date is unverified, and I only saw secondary coverage.

**Pattern.** Cases get picked up when there is:
1. a service with many victims and many criminal customers;
2. a named operator or money trail (crypto, payment receivers, Telegram handles);
3. a corporate partner with legal standing (Microsoft, Google, a bank) or a vetted channel into Europol, Interpol or a national unit;
4. a single dossier that links many reports to one actor.

Individual phishing sites almost never produce investigations. Exfil endpoints (Telegram bot tokens, receivers) and kit fingerprints are what let you cluster sites into one actor, so they are the tool's real value to police.

### Route-by-route

**APWG eCX (US-based non-profit).**
- Who: members (financial institutions, ISPs, security vendors, law enforcement, government, university researchers, NGOs). Non-members can apply to the Researcher Data Grant Program (research centres, universities, multilaterals, NGOs), which gives read access. Source: https://antiphishing.org/cybercrime-researcher.
- Individuals: unclear. An individual operator probably does not qualify as a "research centre or NGO". Ask membership@apwg.org.
- Mechanism: REST API with token, sandbox at sandbox.ecrimex.net, POST to /phish (https://github.com/APWG/ecx). A Data Sharing Agreement is required.
- Dues: I only found $7,500 for the Crypto Working Group. General dues are unconfirmed.
- Feedback: no case numbers. It is an indicator exchange.
- Which LE agencies consume it: I could not verify this. LE are eligible members, but I found no evidence of cases it started. Reporting phish there is cheap and gets the data to vendors and blocklists, not to detectives.
- Also: reportphishing@apwg.org is the email feed (not independently checked).

**Chainabuse (TRM Labs).**
- Who: anyone can report. The reporter can opt in to law-enforcement contact. Source: https://docs.chainabuse.com/docs/post-reports-parameters.
- Mechanism: API at https://api.chainabuse.com/v0 with a key from your profile. It supports batch reports. The public API withholds evidence, geolocation and contact data.
- Law enforcement: a dedicated LE API and Chainabuse Pro tools expose enriched data and reports tied to open investigations (https://docs.trmlabs.com/guides/chainabuse/law-enforcement-partners). It is the official reporting partner for Operation Shamrock (https://www.trmlabs.com/resources/blog/trm-labs-chainabuse-named-official-reporting-partner-for-operation-shamrock).
- Limits: no hard stats on investigations opened. No case numbers. The rate limits I saw conflict. Only useful where wallet addresses are present, e.g. crypto receivers.
- Rating: best fit for payment-receiver evidence.

**Shadowserver (Dutch non-profit).**
- Network owners and CSIRTs can subscribe for free after proving control of their IP ranges (https://www.shadowserver.org/what-we-do/network-reporting/get-reports/). I did not find a phishing-report intake.
- It supports LE disruptions (Endgame, LabHost, Tycoon2FA), but its input comes from its own data and partners. A tool would partner with it, not feed it. Contacting them about hosting seized-domain splash pages or victim notification is an option.

**Spamhaus and abuse.ch/URLhaus.**
- Both work with LE (Endgame, Emotet, Qakbot). Spamhaus says it responds to subpoenas and written requests (https://www.spamhaus.org/history/).
- URLhaus is malware-URL focused, so it is a weak fit for credential phishing. Its data now goes via a commercial API or real-time feed (https://www.spamhaus.com/faqs/abuse-ch/). Submitting there leads to blocking and takedown notices, not cases.

**PhishTank.** New registration has been closed since about 2020 and is reportedly still closed in 2026 (https://en.wikipedia.org/wiki/PhishTank). It is not viable.

**OpenPhish.**
- Intake is by email (report@openphish.com) and covers new, live URLs only.
- The Premium feed is free for LE (the Gov feed page says "may be eligible"). Source: https://openphish.com/phishing_feeds.html.
- It is a blocklist, not an LE referral.

**Netcraft.**
- It has a public report API/form (https://report.netcraft.com/) and a takedown service built on trusted-reporter links with hosts and registrars. I found nothing describing a formal LE referral path.
- Its Darcula tracking has supplied indicators to the industry. I found no arrest that credits it.
- Use it as a takedown amplifier, not an LE route.

**Microsoft DCU.**
- It acts on high-volume M365/brand-impersonation kits and files civil suits. It pushes referrals to LE (RaccoonO365, Tycoon2FA).
- Submission is via MSRC or DCU contact (I did not verify an intake form). Bundle kit-level dossiers there when Microsoft brands are involved.
- Limit: it works on actors it already tracks.

**NCFTA (US).**
- It is a non-profit where industry analysts and the FBI sit together (https://www.fbi.gov/news/stories/the-ncfta-combining-forces-to-fight-cyber-crime). Membership is vetted.
- I found no public intake for third parties, and no evidence of NCFTA in the German or Europol cases above. It is a membership play, not an API.

**Cyber Defence Alliance (UK).**
- It is bank-funded, and it started LabHost. It is closed to individuals; only financial-sector firms can join.
- A phishing tool can reach it only indirectly, via banks or Netcraft-type vendors that are members. Unverified: whether it takes outside intelligence.

**Cybercrime Support Network.** I did not research it; it is a US victim-support non-profit and not an LE feed.

### Best bets for an automated tool (ranked)

1. **Cluster by actor and publish dossiers.** Group captured sites by kit fingerprint, exfil endpoint, Telegram bot token and payment receiver. Send one dossier per cluster to a named recipient. Recipients that pick cases up are: BKA/ZIT (Frankfurt), Europol EC3 (via the vendors with CIEP access: Microsoft, Trend, Proofpoint), and the Met/NCA via UK industry. This is how LabHost, Tycoon2FA and BulletProofLink started. It matters more than any single feed.
2. **Chainabuse API.** It has an open submission API, an opt-in LE contact flag and a dedicated LE access tier. It suits crypto receiver addresses.
3. **APWG eCX via the Researcher Data Grant.** It is an API with industry reach and LE membership, but no case feedback. Apply early because eligibility for a private person is uncertain.
4. **Direct contact with security vendors that run LE pipelines.** Offer curated feeds or evidence to Trend Micro, Proofpoint, Microsoft DCU, Intel 471 and Group-IB. The cases above show they are the usual first hop.
5. **Netcraft and OpenPhish.** Submit for fast takedown and blocklisting. They do not lead to criminal cases.
6. **Shadowserver, Spamhaus, abuse.ch.** Treat as partners for disruption support, not as intake channels.
7. **Skip PhishTank** (closed).

**Uncertainties to check next.** The Kratos origin story (BKA press release); the APWG dues and eligibility for a private person; Chainabuse LE-tier criteria; whether the Cyber Defence Alliance or NCFTA accept third-party submissions; and the iServer date.

---

### Provider preservation

### Data preservation after takedown: provider and registry routes (as of 2026-11-16)

**Main finding.** No provider I found accepts a *binding* preservation request from a private reporter. Every formal route (18 USC 2703(f), Budapest Art. 16/29, EU e-Evidence EPOC-PR) is law-enforcement-only. What a tool can do is:

- send a *voluntary* "suspend, don't delete" request together with the takedown report;
- hand the investigating police a ready-made, per-provider preservation package that quotes the case number (Aktenzeichen).

I found no provider page that explicitly accepts voluntary non-LE preservation. That absence is itself the finding. Provider-by-provider retention after suspension is mostly undocumented, so assume it is short.

### Legal frameworks

- **18 USC 2703(f).** On a government request, a provider must preserve records for 90 days, extendable by one further 90 days ([statute summary](https://www.tspa.org/curriculum/ts-fundamentals/trust-safety-and-law-enforcement/law-enforcement-response/)). It only binds US-reachable providers, and it is for governmental entities. The statute does not limit who may *voluntarily* preserve.
- **EU e-Evidence (Reg. 2023/1543).** It applies from 18 Aug 2026, except in Denmark ([EUR-Lex](https://eur-lex.europa.eu/eli/reg/2023/1543/oj/eng), [Bird & Bird](https://www.twobirds.com/en/insights/2025/eevidence-regulation-key-compliance-takeaways-for-service-providers-by-2026)).
  - Providers had to name a legal representative by 18 Aug 2026.
  - A European Preservation Order (EPOC-PR) means 60 days, extendable by 30 ([Rickert](https://rickert.law/en/eu-e-evidence-overview/)).
  - It is issued by a judicial or prosecutorial authority only, and sent through the e-CODEX "decentralised IT system". That system may not be fully functional yet ([Bird & Bird, DE](https://www.twobirds.com/en/insights/2026/germany/eevidencerichtlinie-umsetzungsfrist-abgelaufen--implementierungsstatus-und-handlungsbedarf)).
  - Real-world uptake is unverified. I found no data on actual orders since August.
- **Budapest Convention Art. 16 and 29.** Both are state-to-state or domestic. They matter when a German police unit asks a US or other foreign provider through the 24/7 network. A private tool cannot use them.

### Providers

| Provider | Finding | Confidence |
|---|---|---|
| **Cloudflare** | [LE page](https://www.cloudflare.com/trust-hub/law-enforcement/) takes email at lawenforcement@cloudflare.com, and the sender must identify as an officer with a badge and case number. Cloudflare says it "generally do[es] not collect or keep" end-user data and cannot remove content it doesn't host. Subscriber data needs a subpoena. The H2 2025 [transparency report](https://cf-assets.www.cloudflare.com/slt3lc6tev37/zItVXCvbb4LZpYG4Uh10R/7b27bba39755f0a4344acb946977704d/2H_2025_Cloudflare_s_Transparency_Report_Legal-v2.pdf) shows no data on stored-content requests. I saw no explicit preservation section, and the 90 days in its materials relates to CSAM. | Medium |
| **DigitalOcean** | [Guidelines](https://www.digitalocean.com/legal/law-enforcement-guidelines) honor 2703(f). They preserve account information "in an offline file for up to 90 days", plus one 90-day extension, limited to what is explicitly requested. Droplet contents are purged immediately on deletion, so the account data is preserved but the server content is not. | High |
| **GitHub Pages** | [Guidelines](https://docs.github.com/en/site-policy/other-site-policies/guidelines-for-legal-requests-of-user-data) have a "Data preservation" section: up to 90 days, formal request from US LE in a criminal investigation. They do not describe renewal. | High |
| **Google (Sites, Firebase, Cloud)** | LERS has a [preservation form](https://lers.google.com/lers/v2/preservation_form?authuser=1) (identifiers, products, date range). Status can be "pending review" for 48 h or more. The 90+90 days comes from third-party guides, not Google, and only data existing at request time is captured. I did not confirm Sites or Firebase coverage. | Medium |
| **Hostinger** | [Abuse policy](https://www.hostinger.com/ph/legal/abuse-policy) has an explicit preservation-request mechanism. It requires the account, the investigating agency and LE letterhead, and formal US legal process otherwise. The [DPA](https://www.hostinger.com/legal/dpa) says customer data is deleted 30 days after termination. The [privacy policy](https://www.hostinger.com/legal/privacy-policy) says data may be kept up to 1 year after a safety suspension to block re-signup. So the account record plausibly survives longer than content. | Medium |
| **Namecheap** | [Disclosure policy](https://www.namecheap.com/legal/general/domain-registration-data-disclosure-policy-guide/): US subpoena or court order to legal@namecheap.com. Foreign LE must use MLAT-type mechanisms. I found no preservation procedure or stated retention period. | Low |
| **OVHcloud** | The [US FAQ](https://us.ovhcloud.com/legal/faqs/legal-law-enforcement/) is old (about 1300 days) and says valid court order only, with MLAT for foreign authorities. A practitioner site ([FireNet](https://www.firenet.com.pl/en/wiedza/pozyskiwanie-danych-z-infrastruktury-ovh-co-naprawde-mozna-uzyskac-i-jak-dzialac-szybko/)) claims a freeze in 48–72 h for 90 days (extendable to 180) with no EIO needed, by email and post to Roubaix. That is **unverified**. OVH fights non-EU orders under the French blocking statute ([Register](https://www.theregister.com/2025/11/27/canada_court_ovh)). | Low |
| **Hetzner** | The [FAQ](https://docs.hetzner.com/general/company-and-policy/data-protection-at-hetzner/) says it accepts **only German authorities' requests (for Falkenstein/Nürnberg) and Finnish ones (for Helsinki)** and rejects foreign ones. The legal notice's only contacts are tco@ (Reg. 2021/784) and dsa-authorities@. I found no preservation page. So a German Aktenzeichen helps here, but a foreign reporter route is closed. | Medium |
| **Telegram (bot tokens)** | The official abuse path is abuse@telegram.org or the in-app report. Only the token owner can revoke the token, via BotFather. The IP/phone disclosure policy is "after a valid judicial order... may disclose" ([Bitdefender](https://www.bitdefender.com/en-us/blog/hotforsecurity/telegram-transparency-report-highlights-rising-data-demands-from-law-enforcement)). In 2024, Telegram says it fulfilled 14 US requests in Jan–Sep, then about 900 in Q4 ([Freedom of the Press](https://freedom.press/digisec/blog/telegrams-compliance-with-data-requests-skyrockets/), [Tom's Guide](https://www.tomsguide.com/computing/online-security/telegram-data-sharing-has-increased-by-6-000-percent-since-ceos-arrest)). I found no preservation mechanism. Don't revoke or ban a bot before police can ask for its data, because banning may destroy evidence. | Low–Med |
| **GoDaddy, Vercel, Netlify, Squarespace/Wix, Contabo, IONOS** | I found no LE guideline or preservation page in this pass. GoDaddy, Vercel and Netlify pages were not retrievable. The Netlify DPA mentions deletion and backup rotation but no periods. I did not search Squarespace, Wix, Contabo or IONOS. Treat as unknown and probe the abuse and legal contacts individually. | Unknown |

Many LE pages are JavaScript-rendered or blocked to plain fetch. A second pass with a real browser could fill the unknown rows.

### Registration data access

- **NIS2 Art. 28.** Registries and registrars must reply to "legitimate access seekers" within 72 h ([text](https://www.nis-2-directive.com/NIS_2_Directive_Article_28.html)). Germany's transposition took effect 6 Dec 2025 ([DENIC](https://blog.denic.de/en/new-legislation-what-is-changing-for-users-of-denics-whois-lookup/)).
- **DENIC (.de).** Requests are case by case, with a form per group. The named groups are authorities, IP holders, creditors with a title, and insolvency practitioners ([DENIC](https://blog.denic.de/en/policy-explained-how-can-you-find-out-who-holds-an-existing-de-domain/)). **No researcher or CERT category is named.** I found no published SLA.
- **EURid (.eu).** There is a Registration Data Disclosure Policy with 72 h (24 h urgent) timing and a request form ([EURid](https://eurid.eu/en/news/eurid-introduces-new-policies-to-comply-with-belgi/)). It is generic legitimate interest, with no explicit researcher track found.
- **ICANN RDRS (gTLDs only).** It is free and global, and security research is a listed requestor type, but registrars participate voluntarily and access isn't guaranteed ([ICANN](https://www.icann.org/resources/press-material/release-2023-11-28-en), [FAQ](https://www.icann.org/rdrs-requestors-faqs-en.pdf)).
  - The pilot ended Nov 2025, and the Board extended operation up to 2 more years ([ICANN](https://www.icann.org/rdrs-en)).
  - A law-enforcement SAML authentication proof of concept is being tested with the FBI and Interpol, with a 24 h target (up to 72 h for complex requests) ([Register](https://www.theregister.com/networks/2026/10/20/icann-testing-tech-to-let-law-enforcement-access-non-public-whois-info/5304036)).
  - It is a web form, not an API. Check ICANN's pilot report for the actual disclosure rate before relying on it.
- **RAA retention.** Under the 2013 RAA data-retention specification, registrars retain registrant data for the registration term plus 2 years (some elements 180 days), and §3.4.4 ends the obligation 2 years after deletion or transfer ([RAA](https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-accreditation-agreement/2013-registrar-accreditation-agreement-17-09-2013-en), [ICANN blog](https://www.icann.org/en/blogs/details/update-on-2013-raa-and-data-retention-waiver-process-28-2-2014-en)). Registrar data therefore survives a takedown by default, so police rarely lose it. Hosting-side logs and content are the real risk. Waivers exist for some registrars, and this is 2013–2015 material that I did not re-verify.

### Best bets for an automated tool

1. **File the police report and get the case number first.** The case number is what turns voluntary requests into compliant preservation. Include it in every provider message. Generate a per-provider "preservation pack" for the investigator, with the account, IP, URL, timestamps and a pre-filled 2703(f) / LERS / DigitalOcean / Hostinger-format request. Without a case number, providers have no reason to act.
2. **Add a "suspend, do not delete; retain account, payment and access logs for LE" paragraph to every takedown report.** It is voluntary and unlikely to bind anyone, but it costs nothing. Keep it factual, and ask for takedown to be done by suspension rather than purge. Best targets are Hostinger (explicit preservation concept, 30-day deletion), DigitalOcean, GitHub, Google and the registrars.
3. **Defer destructive actions on exfiltration channels.** Don't report Telegram bots or revoke tokens until investigators confirm, or delay by a configurable window. Report to abuse@telegram.org only after the police have the data request in flight.
4. **Use RDRS and DENIC/EURid forms only for high-value cases.** They are manual, not API-driven, and researcher eligibility is unconfirmed. RAA retention makes them rarely necessary.
5. **Route by jurisdiction.** German-hosted providers such as Hetzner, IONOS and Contabo need German police. US providers need a US-style request via the police and the FBI/IC3 channel. EU providers will be reachable through EPOC-PR, but it is LE-only and its real-world readiness is unproven. Prepare for e-Evidence by recording the hoster's legal representative.
6. **Verify the "unknown" providers** (GoDaddy, Vercel, Netlify, IONOS, Contabo, Squarespace, Wix) before committing them to the tool.

---

### Follow-the-money

### Follow-the-money and exfiltration-channel routes

**Caveat:** I verified the facts below through search summaries of the sources linked in this section. I did not open every primary page, so confirm each address or endpoint against the provider's own page before hard-coding it. There is no hard evidence in my results that third-party automated reports lead to arrests. Treat "leads to investigations" as unproven for every route unless I say otherwise.

### 1. Money-mule IBAN → receiving bank → FIU/police (Germany/EU)

- **Who may submit:** There is no public IBAN-reporting intake at any bank that I found. A non-victim cannot report an IBAN to the FIU as a suspicious-transaction report (Verdachtsmeldung). That duty and the goAML portal are for obliged entities under § 2 GwG (banks and similar) per § 43 GwG (https://www.zoll.de/DE/FIU/Fragen-Antworten/fragen-antworten_node.html; goAML: https://www.zoll.de/DE/FIU/Aktuelles-FIU-Meldungen/2026/fiu_technischer_hinweis_gwg_meldeverordnung.html). goAML registration is mandatory for obliged entities.
- **Non-obliged persons:** The Zoll FAQ and a WPK note say they can send information via a contact form (https://www.wpk.de/beruf/geldwaeschebekaempfung/). I found no official FIU page defining an API or bulk channel. Treat this as a manual, uncertain route.
- **What actually works:** A criminal complaint (Strafanzeige) against unknown persons that names the IBAN. The Staatsanwaltschaft can then order the account data and freezes. The BKA and LKAs publicly describe "Finanzagenten" (money mules) as a priority (https://www.polizei-beratung.de/themen-und-tipps/betrug/finanzagenten/). Banks routinely close mule accounts and should file a Verdachtsmeldung (https://www.experten.de/id/4917129/betrugsmasche-finanzagenten-immer-raffinierter/). That article is a secondary source.
- **Limit:** Banks do not give feedback to reporters, and no case number comes back.
- **Gap:** I found nothing verifiable on formal bank–LKA channels or bank mass-complaints. Do not assume G4C/LKA bank channels are open to a private operator.

### 2. Crypto wallets

- **Chainabuse (TRM Labs):** This is the only route with a real API.
  - **Submission:** Programmatic and batch report submission is documented (https://docs.chainabuse.com/reference/reports-1). Lookup is `GET api.chainabuse.com/v0/reports` by address or domain, up to 50 per page (https://docs.trmlabs.com/api/chainabuse/reports/get-reports). The docs are about 14 months old, so recheck the current API.
  - **Who may submit:** Anyone, with an API key. Evidence and contact details are not exposed via the API (https://docs.trmlabs.com/guides/chainabuse/welcome-to-chainabuse-api).
  - **Limit:** There is no case number and no investigation feedback. Reports feed TRM's intelligence, which law enforcement and exchanges license. That is indirect value only.
- **Tether freeze:**
  - **Status:** The T3 Financial Crime Unit (Tether, Tron, TRM) accepted only verified law-enforcement requests (https://t3fcu.org/). It claimed over $450M frozen, but reports say it was wound down around August 2026 (https://bitcoinmagazine.com/news/tether-tron-scrap-t3-crime-unit). On 12 Nov 2026 the Digital Crime Task Force (DCTF; Tether, Tron, Chainalysis) was announced, accepting tips and freeze requests from law enforcement (https://trondao.org/announcements/tron-tether-and-chainalysis-launch-digital-crime-task-force-to-proactively-identify-and-disrupt-financial-crime). It has no published response-time targets (https://www.cryptopolitan.com/tether-tron-and-chainalysis-launch-dctf-to-replace-disbanded-t3-unit/).
  - **Consequence:** A private tool cannot request a freeze. Its role is to hand police a clean wallet and transaction package that they pass to the DCTF.
- **Exchanges:** Each exchange's compliance or abuse intake is manual. I did not verify any bulk channel. Binance and similar exchanges act mainly on law-enforcement requests.

### 3. Payment processors

- **Stripe:**
  - **Channels:** There is no dedicated fraud-reporting API. The documented routes are a help-center instruction to "contact Stripe" about a fraudulent business (https://support.stripe.com/questions/reporting-a-fraudulent-transaction-from-a-business-using-stripe), a complaint form (https://stripe.com/complaints, complaints@stripe.com, 15–35 business days: https://support.stripe.com/questions/submit-a-complaint), and an AbuseOne program for merchant fraud and impersonation (https://www.abuseone.com/programs/stripe). The AbuseOne bounty range is the vendor's own claim.
  - **Limit:** The complaint form is aimed at complaints about Stripe itself. A phishing-specific address is unverified (older sources say phishing@stripe.com).
- **PayPal:**
  - **Channels:** Forward the full email unchanged to **phishing@paypal.com** (https://www.paypal.com/us/security/report-suspicious-messages; confirmed in a PayPal press release of 2025-10-15: https://newsroom.paypal-corp.com/2025-10-15-PayPal-Alerts-Consumers-to-Phishing-Scams-and-Encourages-Safety-Tips,1). spoof@paypal.com appears only on a third-party blog, so treat it as unverified.
  - **Receiver-account reporting:** PayPal has no public intake for the receiving account. Police requests go through its law-enforcement process.
- **Limit for both:** I found no evidence of case numbers or reporter feedback.

### 4. Telegram bot-token exfiltration

- **Reporting:**
  - **Channels:** Researcher guidance names Telegram abuse and @notoscam (https://netlas.io/blog/abuse_of_telegram_bot_api/, https://www.forescout.com/blog/revamped-phishing-techniques-how-telegram-and-front-end-hosting-platforms-scale-campaigns/). I could **not** confirm abuse@telegram.org from a primary source.
  - **Revocation:** Only the bot owner can revoke the token via BotFather (https://core.telegram.org/bots/tutorial). No third-party revocation route is documented.
  - **Scale:** Forescout counted 4,145 unique tokens in malicious pages.
- **Law-enforcement cooperation:**
  - **Policy change:** In September 2024 Telegram's privacy policy changed so that IP address and phone number may be disclosed on a valid judicial order naming a suspect in criminal activity (https://thehackernews.com/2024/09/telegram-agrees-to-share-user-data-with.html).
  - **Numbers:** US requests fulfilled in 2024 were 900, affecting 2,253 users, mostly in Q4 (https://cyberinsider.com/telegram-shared-data-on-2253-users-with-u-s-authorities-in-2024/). The UK figure was 142 requests (https://www.bitdefender.com/en-us/blog/hotforsecurity/telegram-transparency-report-highlights-rising-data-demands-from-law-enforcement). The transparency report counts only fulfilled requests and is available only via the @transparency bot. I found no 2025 or 2026 figures.
  - **Implication:** Telegram is a realistic data source for police with a judicial order, but only if the token, chat ID and bot username are preserved. Telegram does not accept preservation requests from private persons. Note that Telegram does not disclose message content.
- **Safety:** Never use a harvested token (for example `getMe` or `getUpdates`). That is unauthorised access under German law and a risk to the operator. Submit tokens to abuse channels and to police in the evidence package only.

### 5. Impersonated brands

| Brand | Channel | Source | Notes |
|---|---|---|---|
| PayPal | phishing@paypal.com | https://www.paypal.com/us/security/report-suspicious-messages | Forward the full email unchanged. |
| DHL | phishing@dhl.com (dhl.de, UK); phishing-dpdhl@dhl.com (NL/BE) | https://www.dhl.de/en/toolbar/footer/sicherheitshinweise.html, https://www.dhlexpress.nl/en/helpdesk/fraude | Addresses differ by region. Prefers attached emails. |
| Amazon | stop-spoofing@amazon.com | https://aws.amazon.com/security/report-suspicious-emails/ | Send as attachment. |
| Microsoft | URL form (https://www.microsoft.com/en-us/wdsi/support/report-unsafe-site-guest); abuse@microsoft.com is only a Q&A claim | | Outlook add-ins are in maintenance mode. |

- **Criminal referrals:** I found no public statement from any of these brands that a third-party report leads to a criminal complaint. Brands do file complaints as the injured party, but that is internal, takes aggregated data, and gives no feedback. Value is mostly takedown, plus brand fraud teams holding the criminal-complaint relationships.
- **Not verified:** G4C and bank/LKA channels; any bank-specific phishing mailboxes (I did not research them individually); UK and US equivalents (not covered by my searches).

### Ranked best bets for an automated tool

1. **Evidence package for a German criminal complaint (Strafanzeige) or other national police report.** The package carries the IBANs, wallet addresses, bot tokens and chat IDs, stamped with a hash and timestamp. It is the only route that triggers compulsory orders to banks, Telegram and exchanges. The operator's identity is the main constraint: file as a witness or reporting person. Do not auto-submit; batch it per campaign.
2. **Chainabuse API (batch submit).** It is free, needs no identity, and is fully automatable. It feeds the TRM/Chainalysis-type intelligence that exchanges and police use. Expect no feedback.
3. **Brand mailboxes (phishing@paypal.com, phishing@dhl.com, stop-spoofing@amazon.com).** They are cheap and automatable, but need per-region address tables and verification that the addresses are current. They help takedown but give no referral feedback.
4. **Telegram abuse/@notoscam.** Automatable only if Telegram's channel is confirmed. It is low value for evidence preservation. It mainly burns the criminals' infrastructure, which can cost the police a lead, so coordinate with a case officer before reporting.
5. **Stripe abuse (AbuseOne/complaint form) and the FIU contact form.** Both are manual or semi-manual and unverified for third parties, so use them only for high-value cases.
6. **Tether/DCTF and exchange freezes.** Not available to a private tool; only pass the data to police.

**Open questions to verify before building:**

- The current Telegram abuse address.
- Whether the DCTF is law-enforcement-only.
- Whether Germany's FIU contact form accepts structured data.