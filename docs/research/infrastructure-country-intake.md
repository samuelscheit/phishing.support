# Infrastructure-country intake: can the hosting country open its own case?

Date: 2026-11-17

Question: besides the German complaint, can phishing.support trigger an investigation directly in the country where the phishing infrastructure sits? The aim is that local police get subscriber, payment and log data with a domestic order instead of Germany using mutual legal assistance. Countries: USA, Lithuania, Netherlands, United Kingdom, France, Ireland, Singapore, Turkey, China, Russia, India, Canada. They follow the hosters and registrars seen in production data.

This report deepens [criminal-referral-routes.md](criminal-referral-routes.md), which covers victim intakes (IC3, Report Fraud, Fraudehelpdesk, Europol) and provider preservation practice. It is country by country. The generic instruments are analysed in [cross-border-investigation-instruments.md](cross-border-investigation-instruments.md) and not repeated here:

- Art. 21 ECMA / RiVASt Nr. 145–147;
- Regulation (EU) 2024/3011 on transfer of proceedings;
- spontaneous information under § 61a and § 92d/e IRG;
- e-Evidence;
- JITs and Eurojust.

Coordination bodies and private-party entry points are in [multi-country-coordination.md](multi-country-coordination.md).

Method:

- One research pass per country and one for the treaty status, against police, prosecution, ministry, CERT and statute pages, the CoE treaty office and EUR-Lex.
- I re-checked these on the primary pages myself on 2026-11-17:
  - the CoE charts for ETS 185, CETS 224 and ETS 030;
  - the Commission e-Evidence readiness list;
  - politie.nl, SPF I-Witness, Hostinger's terms and abuse policy;
  - the Bundestag IRG vote.

Markers:

- **[unverified]**: not confirmed on a primary page.
- **Assessment**: my judgement, not a sourced fact.
- No statistics have been estimated or invented. Where a section says "low" or "very low", that is an assessment.

## Main findings

1. **Jurisdiction is not the obstacle.** Every country examined treats an offence carried out through a server or hosting account on its territory as committed there, whatever the victims' nationality.
   - **Most explicit:**
     - Singapore: CMA s.13(3)(b), "the computer, program or data was in Singapore".
     - India: IT Act s.75(2), "involves a computer … located in India".
     - China: Criminal Law art. 6(3), plus the 2022 SPC/SPP/MPS opinion that names the server location as a place of crime.
     - Ireland: Theft and Fraud Offences Act 2001 s.9, "operates … a computer within the State".
   - **Weakest:**
     - USA: wire fraud needs the US wire to be a "core component".
     - UK: CMA only reaches the attacked computer; Fraud Act ss.6/7 via CJA 1993 is the route.
     - Canada: a server alone is a weak "real and substantial link" under Libman.
2. **Intake is the obstacle.** No country has a channel built for a foreign, non-victim reporter that reliably yields a case number:
   - **Explicit refusal or geofencing:** the Netherlands says reports of fraud by Dutch companies from abroad are "not yet possible" ([politie.nl](https://www.politie.nl/en/information/i-want-to-report-a-dutch-citizen-or-company.html)). Singapore's e-services need Singpass. India's portal needs an Indian mobile OTP and seems geo-blocked [unverified]. The US, UK, Canada and Ireland run victim-oriented portals.
   - **Formally possible:** a signed written report to Lithuanian police, a written ihbar to a Turkish prosecutor, a written dénonciation to a French procureur (J3 Paris), and a signed заявление in Russia or report in China.
3. **Legality-principle countries must at least decide on a report.**
   - Lithuania: a reasoned refusal must be sent to the reporter and can be appealed (BPK Arts. 2, 166, 168).
   - Turkey: a non-prosecution decision is served on the informant (CMK 158(6), 160).
   - Russia and China have formal duties but substantive thresholds that a report with only foreign victims cannot meet in practice.
   - India: FIR registration is mandatory (Lalita Kumari), but BNSS s.173(3) allows a 14-day preliminary enquiry for 3–7-year offences.
   - Singapore: "must" investigate, with a "not serious" opt-out (CPC s.17(2)).
   - Opportunity principle: USA, UK, Netherlands, France, Ireland, Canada.
4. **Domestic powers are strong almost everywhere, and often need no judge for subscriber data.**
   - Without a judge: US subpoena under 18 USC 2703(c)(2), which includes means of payment; NL art. 126nc Sv; UK IPA entity data; SG CPC s.20; IN BNSS s.94; CN evidence notice; LT subscriber requests.
   - Retention duties exist only in some countries:
     - Turkey: Law 5651 makes hosters keep traffic data 1–2 years.
     - India: CERT-In Directions require logs for 180 days and KYC data of VPS and cloud customers for 5 years.
     - China: logs at least 6 months.
     - Russia: hoster KYC and long retention by information distribution organisers.
     - None generally in the US, NL, UK, CA or IE.
   - **Notable:** Canada's preservation demand (Criminal Code s.487.012) runs **90 days for an offence under foreign law** that is being investigated abroad. It is issued by a peace officer, without a judge.
5. **The "hosting country" is usually not where the data is.**
   - **Hostinger:** EU customers contract with **Hostinger International Ltd (Cyprus)**, not the Lithuanian company ([terms](https://www.hostinger.com/legal/universal-terms-of-service-agreement)).
   - **Alibaba Cloud International** contracts through Singapore or EU entities. **Eranet** is a Hong Kong company.
   - **US platforms behind Cloudflare:** Cloudflare hides the origin, so a server country is often unknown.
   - **Three separate facts.** The tool should record them per item:
     - physical server location, which decides jurisdiction and seizure;
     - contracting entity, which holds subscriber and payment data;
     - ASN country, which is what geolocation shows.
6. **The fastest data route skips the foreign case.** Since 18 Aug 2026 a German prosecutor can send a **European Production Order (EPOC)** directly to any provider offering services in the EU. That includes US platforms, Hostinger, OVHcloud, Alibaba's EU entities and registrars with EU addressees. It yields subscriber data for any offence and traffic data for offences with a maximum of at least 3 years, within 10 days or 8 hours in emergencies.
   - **Caveat:** Germany is listed as ready to issue **EPOCs only, not European Preservation Orders (EPOC-PR)** ([Commission, 6 Nov 2026](https://commission.europa.eu/document/download/5b3c2ee0-4055-4694-82c3-dc265cd6f108_en?filename=Information%20on%20Member%20States%20ready%20to%20issue%20and%20or%20receive%20EPOCs%20and%20EPOCS-PR.pdf)). Preservation still runs through the BKA 24/7 point under Budapest Art. 29.
7. **A foreign case pays off only where Germany cannot reach.** That means non-EU providers without an EU addressee (Corelux in Turkey, 20i in the UK, Tucows in Canada [unverified whether they have EU addressees]), or a hoster that is itself complicit (bulletproof hosting). In both cases the realistic trigger is German spontaneous information or a Verfolgungsersuchen from the prosecutor. A report from phishing.support does not trigger it.
   - **Real precedents:**
     - Turkey (Istanbul, July 2026): a case opened on information from Czech judicial authorities [press].
     - France (J3, SocksEscort): opened after US authorities reported French servers.
     - Lithuania (Tycoon2FA): measures after a Trend Micro tip routed through Europol.
     - Netherlands: bulletproof-hoster seizures, Oct 2026.
   - **None started from a foreign private reporter's direct complaint.**

## Comparison

| Country (providers) | Jurisdiction over hosted infra | Foreign third-party intake | Must investigate | Cooperation instruments with DE | Verdict |
|---|---|---|---|---|---|
| **USA** (Cloudflare, GoDaddy, Google, Render, Vercel, GitHub, Microsoft, AWS, Namecheap, NameSilo, Dynadot, MarkMonitor) | Yes in principle: CFAA "protected computer"; wire fraud only if the US wire is a "core component"; §1029(h) does not reach foreign credentials | tips.fbi.gov / IC3 / field offices; no case number, no feedback | No: Justice Manual 9-27.220 lets prosecutors decline when "effective prosecution in another jurisdiction" exists | Budapest since 2007; 2AP signed only; DE–US MLAT in force 2009; EU–US MLA; CCIPS 24/7; e-Evidence reaches US providers via EU addressee | Direct ≈ no case. German case → EPOC to EU addressee + 2703(f) via 24/7 |
| **Lithuania** (Hostinger AS/ops; contract entity Cyprus) | Yes: BK Art. 4(2)–(3), place of acting or of consequences | Yes, formally: non-victim reports allowed (BPK 166); must be identified and signed (QES or signed letter); ePolicija needs LT eID; cyberpolice@policija.lt | **Yes**, legality principle (BPK 2, 166); refusal only if manifestly wrong; reasoned and appealable (168) | Budapest 2004; 2AP signed; EIO, EU MLA 2000, e-Evidence; Verfolgungsersuchen directly between judicial authorities; 24/7 at the Criminal Police Bureau | **Best direct option on paper**, but the data sits with Hostinger Cyprus. Direct: low to moderate, likely opened then suspended |
| **Netherlands** (Realtime Register / Registrar.eu) | Yes: art. 2 Sr + ubiquity case law | **No**: politie.nl says reporting fraud by Dutch companies from abroad is "not yet possible"; only the anonymous M. tip line | No: opportunity principle (art. 167 Sv) | Budapest 2007; 2AP signed; EIO, e-Evidence; DE–NL 1979 supplementary treaty; direct judicial channel; 24/7 at National Police | Direct: very unlikely. German EPOC + spontaneous information to Team High Tech Crime |
| **United Kingdom** (20i; Hostinger UK Ltd for UK customers) | Yes for Fraud Act ss.6/7 (CJA 1993 Group A); CMA only if a UK computer was attacked | Report Fraud (UK-resident focus) → NFIB "information report"; no channel for foreign third parties | No: police discretion; CPS Code | Budapest 2011; 2AP signed; no e-Evidence; TCA Title VIII + ECMA (**Art. 21 reserved**); NCA 24/7 (voluntary preservation) | Direct: low. German request via NCA 24/7 (20i keeps hosting data 30 days) + MLA; big kits via UK industry bodies |
| **France** (OVHcloud and others) | Yes: Code pénal 113-2 (one constituent act in FR) | Written dénonciation to the procureur / J3 Paris (French, post, attachments); PHAROS anonymous, no feedback; THESEE victims only | No: opportunity principle (CPP 40-1); J3 has 5 magistrates (2024) | Budapest 2006; 2AP signed; EIO, e-Evidence; DE–FR 1974 supplementary treaty; 24/7 point | Direct: low except for large OVH clusters. German EPOC + spontaneous information to J3 |
| **Ireland** (EU entities of US firms) | Yes: 2001 Act s.9 (computer within the State); 2017 Act s.10 untested | None: local Garda station only; online form for theft ≤ €1,000/€500 | No: discretion; DPP public-interest test | Budapest signed, **not ratified**; 2AP not signed; **no EIO**; e-Evidence yes (ready to receive); ECMA / EU MLA 2000 | Direct: futile. EPOC to the Irish EU addressee |
| **Singapore** (Gname; Alibaba Cloud Intl; Hostinger Pte for some) | Yes: CMA s.13(3)(b), explicit | I-Witness tip only (anonymous OK, 5 attachments, no feedback, "not a police report"); formal report needs Singpass or presence | Formally yes (CPC s.17(1)) but opt-out for "not serious" (s.17(2)) | Not Budapest; no DE treaty (MACMA reciprocity, s.16(2)); UNTOC; Europol working arrangement 2024; Interpol | Direct: low. I-Witness as intelligence; German case → BKA/Interpol/Europol + MACMA |
| **Turkey** (Corelux) | Yes: TCK Art. 8 (act partly in Turkey) | Written ihbar to any prosecutor's office (CMK 158), Turkish in practice; UYAP needs a Turkish ID; siberguvenlik.gov.tr is takedown only | **Yes**, legality principle (CMK 160, 170); but 158(6) quick dismissal of "abstract and general" reports; decision served on informant | Budapest 2015; 2AP **not** signed; ECMA + ETS 182; Law 6706 transfer of proceedings; 24/7 at police cybercrime department; Europol strategic only | Direct: low. German request via 24/7 for preservation (5651 retention 1–2 y) + spontaneous information or transfer via Ministry of Justice |
| **China** (Alibaba/Aliyun; Eranet is HK) | Yes: CL art. 6(3); server location named as place of crime (法发〔2022〕23号) | Formal only (CPL art. 110; cyberpolice.cn in Chinese); CNCERT / anti-phishing alliance for takedown | Filing duty (CPL 112) but "情节严重" (serious-circumstances) thresholds; foreign victims not prioritised | Not Budapest; no DE–CN MLA treaty; DSL art. 36 and ICJAL art. 4 block evidence export; DE–HK MLA suspended 2020 | Direct: futile. Takedown via CNCERT; EPOC to Alibaba EU entities where they are the contracting party |
| **Russia** (Mastertel) | Yes: UK RF Art. 11 | Formal: signed Russian заявление (UPK 141), 59-FZ covers foreigners; no anonymous reports | Formal duty to check (UPK 144) but needs proven damage | Not Budapest; ECMA still listed by CoE and RU MoJ; state cooperation frozen since 2022 | No realistic chance, and it exposes the reporter's identity. Takedown only |
| **India** (PublicDomainRegistry) | Yes: IT Act s.75(2), explicit | Practically none: portal needs Indian mobile OTP and seems geo-blocked [unverified]; e-FIR must be signed within 3 days; CERT-In is takedown only | FIR mandatory (Lalita Kumari) but 14-day preliminary enquiry (BNSS 173(3)) | Not Budapest; G7 24/7 via CBI; DE–IN MLAT signed 2024, DE ratification law 11/2025, entry into force [unverified]; Art. 16 spontaneous information names cybercrime | Direct: very low. German case → BKA/Interpol → CBI; CERT-In logs 180 d, KYC 5 y |
| **Canada** (Tucows) | Yes if a "real and substantial link" exists (Libman); weak for a server alone | CAFC / NC3 portal ("victim or witness", anonymous OK) = intelligence repository; investigation is local police | No: police discretion (Beaudry); Crown two-part test | Budapest 2015; 2AP signed; DE–CA MLA treaty 2002; NC3 24/7; **s.487.012 preservation for foreign offences, 90 days** | Direct: very low. German request → NC3 preservation demand + MLA |

Treaty status checked on the CoE treaty office on 2026-11-17:

- **ETS 185 in force:** USA 01/01/2007, Lithuania 01/07/2004, Netherlands 01/03/2007, UK 01/09/2011, France 01/05/2006, Türkiye 01/01/2015, Canada 01/11/2015, Germany 01/07/2009. Ireland has signed only. Singapore, India, China and Russia are not listed. ([chart](https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185))
- **CETS 224 not in force:** 4 of the 5 required ratifications (Serbia, Japan, Hungary, Costa Rica). ([chart](https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224))
- **ETS 030:** still lists Russia (in force 09/03/2000) with no denunciation date. ([chart](https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=030))

## German-side levers referenced in the verdicts

Details and sources are in [cross-border-investigation-instruments.md](cross-border-investigation-instruments.md). The short version:

- **EPOC (Reg. 2023/1543).**
  - Issued by a German prosecutor (subscriber data) or a judge (traffic and content data) directly to a provider's EU addressee.
  - Germany is legally and technically ready to issue EPOCs.
  - Lithuania, the Netherlands and France are not on the Commission's readiness list. Orders then go by the Commission's contingency means.
- **Budapest Art. 29 / 24/7 network.** The BKA asks the hosting state's 24/7 point for expedited preservation (at least 60 days). This is the only preservation route Germany can use today, since it cannot issue EPOC-PRs.
- **Spontaneous information.**
  - Bases: Budapest Art. 26, EU MLA Convention Art. 7, § 61a IRG for prosecutors, §§ 92d/92e IRG for police via SIENA.
  - § 61a requires an offence with a maximum of **more than 5 years**, or "erhebliche Bedeutung" where data protection is adequate. Basic § 263a StGB (max. 5 years) does not meet the first alternative; commercial or gang-based forms do.
  - The new IRG adopted by the Bundestag on 12 Nov 2026 enters into force twelve months after promulgation ([Bundestag](https://www.bundestag.de/dokumente/textarchiv/2026/kw46-de-rechtshilfe-strafsachen-1231516)). Its § 120 reportedly lowers the threshold to "erhebliche Bedeutung", per the government bill [unverified in final text].
- **Verfolgungsersuchen (RiVASt 145–147) / Art. 21 ECMA.**
  - Built for a known suspect abroad.
  - The UK reserved Art. 21.
  - Reg. 2024/3011 (from 1 Feb 2027) lets an EU state refuse a transfer when no part of the offence or damage occurred there and the suspect is not a national or resident (Art. 12(2)(c)). That is exactly the pure-hosting case.

---

## USA

### 1. Jurisdiction

- **CFAA, 18 USC 1030.** A "protected computer" includes any computer "used in or affecting interstate or foreign commerce or communication" (§1030(e)(2)(B)), so any server in a US data centre (GoDaddy, AWS, Vercel and so on) qualifies. §1030(a)(2)(C) punishes intentional unauthorised access that obtains "information from any protected computer". §1030(a)(4) covers access with intent to defraud that obtains anything of value. §1030(b) covers attempt and conspiracy. [https://www.law.cornell.edu/uscode/text/18/1030]
- **Using a US-hosted kit against German victims.** Most German phishing kits harvest credentials from victims in Germany, so the "access" (a German bank or PayPal.de account) is not on a US computer. The US hook is therefore usually wire fraud or access-device fraud, not §1030(a)(2). This is my analysis.
- **Wire fraud, 18 USC 1343.** The statute has no extraterritorial reach. The Second Circuit held that it applies to domestic conduct when "(1) the defendant used domestic mail or wires in furtherance of a scheme to defraud, and (2) the use … was a core component", and that the wires must be "essential, rather than merely incidental". A phishing page served from a US server, or credentials sent to a US-hosted panel, arguably meets this test, but that is contestable when everything else is foreign (Bascuñán v. Elsaca, 2d Cir. 2019) [https://law.justia.com/cases/federal/appellate-courts/ca2/18-2731/18-2731-2019-06-13.html]. Other circuits apply different tests [unverified].
- **Access devices, 18 USC 1029.** Covered conduct includes possessing 15 or more unauthorised access devices (§1029(a)(3)) and transactions with access devices issued to another person (§1029(a)(5)), "if the offense affects interstate or foreign commerce". The extraterritorial clause in §1029(h) only reaches devices issued by a US-organised entity, so German bank credentials do not qualify. Foreign actors are therefore caught only for conduct inside the US. [https://www.law.cornell.edu/uscode/text/18/1029]
- **Money laundering, 18 USC 1956.** §1956(f) gives extraterritorial jurisdiction if a non-citizen's conduct "occurs in part in the United States" and involves more than $10,000. §1956(c)(7)(B)(iii) makes fraud against a foreign bank a predicate offence. [https://www.law.cornell.edu/uscode/text/18/1956]
- **Identity theft, §§1028/1028A.** These are also available [not fetched in this run, unverified].

### 2. Intake

- **tips.fbi.gov.** This is a case-intake form and is anonymous-capable. For cyber-enabled crime it sends users back to IC3 ("please submit a tip to IC3.gov"). The page says nothing about attachments, foreign submitters or feedback. [https://tips.fbi.gov/home]
- **FBI or Secret Service field offices.** DOJ CCIPS tells people reporting intrusion or internet fraud to contact a local FBI or Secret Service field office, ask for the "Duty Complaint Agent", or use IC3. Phishing is not named on the page, and there is no foreign-reporter channel. [https://www.justice.gov/criminal/criminal-ccips/reporting-computer-internet-related-or-intellectual-property-crime]
- **Secret Service Cyber Fraud Task Forces.** These are partnerships of law enforcement, prosecutors and industry, and they are contacted through field offices [https://www.secretservice.gov/sites/default/files/reports/2020-12/Preparing%20for%20a%20Cyber%20Incident%20-%20An%20Introductory%20Guide%20v%201.1.pdf]. There is no public intake for foreign third parties [unverified, the CFTF page was not reachable].
- **No victim-independent complaint.** There is no right to file a criminal complaint that obliges anyone to act, and US agencies give no case numbers. Prosecution is initiated by the agency and the US Attorney.
- **Takedown, not a case.** Abuse desks of the registrar or host, and CISA, only remove content. They open no case.

### 3. Legality vs opportunity

- **Pure opportunity principle.** Under Justice Manual 9-27.220 a prosecutor may decline even a provable case if there is no "substantial federal interest", if the person is subject to "effective prosecution in another jurisdiction", or if there is an adequate non-criminal alternative. [https://www.justice.gov/jm/jm-9-27000-principles-federal-prosecution]
- **Factors.** 9-27.230 weighs federal enforcement priorities, the seriousness of the offence, deterrence and "the interests of any victims". [same URL]
- **Effect on foreign-victim cases.** A case with only German victims and German prosecutors able to act fails the 9-27.220 test almost by default.
- **Loss thresholds.** USAO declination thresholds exist but are not public [unverified].

### 4. Domestic powers

- **Subpoena, 18 USC 2703(c)(2).** An administrative, grand jury or trial subpoena gets the subscriber's name, address, session times, length of service, "temporarily assigned network address" and "means and source of payment … (including any credit card or bank account number)". No judge is needed, so this is fast. [https://www.law.cornell.edu/uscode/text/18/2703]
- **Court order, 2703(d).** This gets non-content records such as logs. The standard is "specific and articulable facts" showing the records are "relevant and material to an ongoing criminal investigation". [same]
- **Content.** Content requires a warrant [2703(b)/(a), same].
- **Preservation.** Under 2703(f) a provider must preserve data on request for 90 days plus a renewable 90 days. [same]
- **Data held abroad.** The CLOUD Act, 18 USC 2713, extends these obligations to data "located within or outside of the United States". [https://www.law.cornell.edu/uscode/text/18/2713]
- **No retention mandate.** The DOJ manual says no law regulates how long providers must keep records, and preservation cannot cover records not yet created (2002/2009 editions) [https://www.thecre.com/fedlaws/legal8/s_smanual2002.htm, secondary mirror of the DOJ manual].

### 5. Cooperation

- **Budapest Convention.** Signed 23/11/2001, ratified 29/09/2006, in force 01/01/2007. [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185]
- **Second Additional Protocol (CETS 224).** Signed 12/05/2022, not ratified as of 17/11/2026. [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224]
- **US–Germany MLAT.** Signed 14/10/2003, in force 18/10/2009, together with the 2006 supplementary treaty that implements the EU–US agreement. [https://www.state.gov/09-1018, https://www.state.gov/09-1018-1]
- **EU–US MLA agreement.** In force 01/02/2010. It covers joint investigation teams and the "prompt identification of financial account information". [https://www.justice.gov/archives/opa/pr/useu-agreements-mutual-legal-assistance-and-extradition-enter-force]
- **EU e-Evidence regulation.** It does not bind the US as a state. It does apply to US providers that offer services in the EU, through their EU legal representative, so a German prosecutor can send a production order directly to GoDaddy, Cloudflare, Google and the like [Reg 2023/1543 Art. 2(1), https://eur-lex.europa.eu/eli/reg/2023/1543/oj, not re-fetched, unverified].
- **24/7 contact point.** DOJ CCIPS has been the US 24/7 point of contact since 1997. [https://www.justice.gov/archives/opa/pr/criminal-division-s-computer-crime-and-intellectual-property-section-celebrates-20-years]

### 6. Evidence of practice

- **Star Blizzard, October 2024.** The Northern District of California seized 41 spear-phishing domains, alongside a parallel Microsoft civil action that took 66 more. Private-sector intelligence fed the operation. [https://www.justice.gov/usao-ndca/pr/justice-department-disrupts-russian-intelligence-spear-phishing-efforts]
- **HeartSender, January 2025.** The Southern District of Texas seized 39 domains and servers selling phishing kits, together with the Dutch police. The basis was US victims with over $3M in losses. [https://justice.gov/usao-sdtx/pr/cybercrime-websites-selling-hacking-tools-transnational-organized-crime-groups-seized]
- **LummaC2, May 2025.** DOJ seized 5 domains, separate from Microsoft's civil action against about 2,300 domains. [https://www.justice.gov/opa/pr/justice-department-seizes-domains-behind-major-information-stealing-malware-operation]
- **What these cases share.** Each had a US-victim or national-security nexus, a large industry partner or foreign police, and no small private reporter. I found no case where a US agency opened a case on a foreign private tip about phishing that hit only foreign victims.

### 7. Verdict

**A direct report is unlikely to open a case.** The substantive law reaches US-hosted phishing infrastructure in principle, and 2703(c)(2) would quickly produce subscriber and payment data. But the realistic chance that a report from phishing.support (German victims only) opens a US case is close to zero. The reasons:

- Federal prosecution is fully discretionary, and JM 9-27.220 names "effective prosecution in another jurisdiction" as a reason to decline.
- Cyber tips are routed into IC3, with no feedback or case number.
- US practice targets US victims or large-scale services.

**The better route has three parts:**

1. **German criminal case first.** Report to Bavarian police or the ZCB (Generalstaatsanwaltschaft Bamberg) and keep the evidence bundle ready.
2. **German authority acts quickly.** Ask it to send a 2703(f) preservation request through the BKA 24/7 point of contact to CCIPS, and to issue an EU production order directly to the US provider's EU representative. For larger campaigns it can add spontaneous information under Art. 26 Budapest Convention, the MLAT/EU–US channel, or the FBI legal attaché in Berlin [unverified].
3. **Notify the US host and registrar abuse desks in parallel.** This removes the content and often keeps account records that later production orders can reach.


---

## Lithuania

### 1. Jurisdiction

- **Territorial scope.** Criminal Code (BK) Art. 4(1) applies Lithuanian law to anyone who commits a criminal act on Lithuanian territory. Art. 4(2) defines the place of the act as where the person "acted or ought to have acted or could have acted or the place in which the consequences … occurred". For accomplices, it is also wherever one of them acted. Art. 4(3) covers an act that is partly abroad if it was "commenced or completed or discontinued" in Lithuania. [https://www.unodc.org/documents/treaties/UNCAC/CountryVisitFinalReports/2013_10_29_Lithuania_Final_Country_Report/2013_10_29_Lithuania_Annex_1_Legislation.pdf] (a 2013 unofficial translation; the official BK at e-seimas.lrs.lt/rs/legalact/TAD/a84fa232877611e5bca4ce385a9b7048/ was behind a Cloudflare block for me).
- **Hosting as a place of the act.** Running a phishing site or a credential sink on a Lithuanian server is plausibly "acting" in Lithuania even if every victim is German. That is my reading of Art. 4(2)–(3). I found no Lithuanian case law on server location [unverified].
- **Art. 5** covers Lithuanian citizens and permanent residents for crimes committed abroad. It matters only if the operator is Lithuanian [same UNODC source].
- **Offences that fit phishing:**
  - Art. 182: swindling, i.e. getting property by deceit [https://www.lithuanialaw.com/lithuanian-criminal-code-495] [unverified current wording].
  - Art. 196: unlawful influence on electronic data.
  - Art. 197: unlawful influence on an information system.
  - Art. 198: unlawful interception and use of electronic data [https://sherloc.unodc.org/cld/en/legislation/ltu/criminal_code/chapter_xxx_/article_198/article_198.html].
  - Art. 198¹: unlawful connection to an information system.
  - Art. 198²: unlawfully producing, distributing, acquiring or storing "installations, software, passwords, login codes and other data" directly intended for committing crimes. This covers phishing kits and stolen credentials [https://sherloc.unodc.org/cld/en/legislation/ltu/criminal_code/chapter_xxx_/article_1982/article_198-2.html].
  - Arts. 214–215: electronic means of payment and their data [https://www.derechos.org/intlaw/doc/ltu1.html] [unverified current text].
  - Art. 216: money laundering [unverified current text].

### 2. Intake

- **Police complaint channel: ePolicija** ([https://www.epolicija.lt]).
  - Login goes through the Lithuanian e-government gateway: Lithuanian e-banking, eID, or an e-resident card [https://epolicija.prisijungti.lt/; https://punskas.pl/wp-content/uploads/2021/06/Elektroniniai-valdzios-vartai.pdf] (secondary sources).
  - Logged-in users get status updates by e-mail or SMS. A report sent only by e-mail to epolicija@policija.lt does not get these updates [https://e-seimas.lrs.lt/rs/actualedition/TAIS.377942/zHWPxCsnAn/format/ISO_PDF/].
  - The portal warns that complaints without a name, address or signature may be left unexamined, citing Law on Public Administration Art. 23(3) [https://www.epolicija.lt].
- **Police FAQ on identity.** An e-mailed request needs a qualified e-signature. Otherwise you post a hand-signed letter with a copy of your ID or passport [https://policija.lrv.lt/lt/dazniausiai-uzduodami-klausimai-1/prasymai-ir-pranesimai-policijai/].
- **Anonymous reports** count only as "information unofficially provided to the police", not as a formal complaint [https://www.nukentejusiems.lt/en/report-crime-get-help/].
- **Language.** Non-Lithuanian speakers may file in their own language or through an interpreter. This applies to victims [https://vilnius.policija.lrv.lt/lt/policija-pataria/informacija-nukentejusiems-asmenims/]. I found no English portal [unverified].
- **Who may file.** BPK Art. 166(1) does not require the reporter to be a victim: any "skundas, pareiškimas ar pranešimas" (complaint, statement or report) about a crime is enough [https://www.infolex.lt/ta/10708:str166].
- **Feedback.** If the police refuse to open a case, a reasoned decision must be sent to the reporter (Art. 168(3)) [https://www.infolex.lt/ta/10708:str168]. So a signed report from a foreign organisation does get feedback.
- **Cybercrime unit.** The LKPB cyber unit (Serious and Organised Crime Board 5, Saltoniškių g. 19, Vilnius) can be reached at cyberpolice@policija.lt. It asks for written requests with headers and screenshots [https://www.nksc.lt/kontaktai.html].
- **Takedown / CERT channel, not a case opener.** NKSC/CERT-LT takes reports by web form or phone 1805 [https://www.nksc.lt/kontaktai.html]. Hostinger takes reports at abuse@hostinger.com and compliance@hostinger.com, in English, Lithuanian or Greek [https://www.hostinger.com/legal/abuse-policy].

### 3. Legality vs opportunity principle

- **Legality principle applies.** BPK Art. 2 says prosecutors and pre-trial bodies "privalo" (must), in every case where signs of a crime appear, take all lawful measures to investigate quickly [https://www.infolex.lt/ta/10708:str2].
- **Opening.** Art. 166(1) opens an investigation on receipt of a complaint, statement or report [https://www.infolex.lt/ta/10708:str166].
- **Refusal** is allowed only if the data is "akivaizdžiai neteisingi" (manifestly incorrect) or an Art. 3(1) bar clearly applies. Verification steps are capped at 10 days (Art. 168(1)).
- **Appeal.** A refusal can be appealed to the prosecutor and then to the pre-trial judge within 7 days (Art. 168(5)) [https://www.infolex.lt/ta/10708:str168].
- **Thresholds.** I found no published minimum-loss threshold or policy that deprioritises foreign victims [unverified]. In practice, a case with no identified suspect will probably be opened and then suspended [unverified].

### 4. Domestic powers

- **Subscriber data** (e-mail addresses, accounts, payment-instrument holders) can be had on a simple police or prosecutor request, without a judge. The basis is Prosecutor General order No. I-383 under BPK Art. 155 [https://www.ejn-crimjust.europa.eu/ejnupload/DynamicPages/LT%20electronic%20evidence%20fb.pdf].
- **Traffic data** needs a prosecutor's order with the pre-trial judge's consent (Art. 155(1)).
- **Content and real-time interception** fall under Art. 154 and need a judge's order, for up to 6 months, extendable once by 3 months. Art. 154(3) also covers Art. 198¹.
- **Urgent orders.** A prosecutor may act alone under Art. 160¹, but a judge must approve within 3 days [same EJN fiche].
- **Non-compliance** is fined under Art. 163 [same EJN fiche].
- **Preservation.** Police may order preservation and disclosure of subscriber identity, accounts and payments under Law on Cyber Security Art. 10(4). Flow data needs a court ruling [same EJN fiche]. The article number may have changed with the NIS2 rewrite [unverified].
- **Data retention.** Law on Electronic Communications Arts. 65–66 impose 6 months of retention, extendable by 6 months under Art. 77(3). This binds electronic-communications providers [same EJN fiche]. As far as I can tell it does not bind a web hoster such as Hostinger [unverified].
- **Speed.** There is no fixed deadline. Providers must answer "immediately", and foreign preservation requests are handled "without undue delay" [same EJN fiche].
- **Hostinger's own process** accepts court orders, warrants and European Production and Preservation Orders, and may notify the customer unless that is prohibited [https://www.hostinger.com/legal/abuse-policy].

### 5. Cooperation

- **Budapest Convention:** signed 23/06/2003, ratified 18/03/2004, in force since 01/07/2004 [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185].
- **Second Additional Protocol:** Lithuania signed on 12/05/2022 and has not ratified. Germany signed on 27/01/2023 and has not ratified [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224].
- **24/7 contact point:** the Lithuanian Criminal Police Bureau [https://www.coe.int/en/web/octopus/country-wiki-ap/-/asset_publisher/CmDb7M4RGb4Z/content/lithuania?_101_INSTANCE_CmDb7M4RGb4Z_viewMode=view%2F].
- **MLA routes:** BPK Art. 66 sends requests via the Ministry of Justice or the Prosecutor General's Office, or via the Lithuanian Eurojust member. Legal bases are the EU MLA Convention 2000 and the EIO, which Lithuania accepts in Lithuanian or English [same Octopus page; EJN fiche].
- **Bilateral treaty with Germany:** I found none. The EIO Directive 2014/41 and the 2000 Convention are the framework [unverified that no bilateral treaty exists].
- **EU e-Evidence:** Regulation 2023/1543 applies since 18/08/2026, so a German prosecutor can send a European Production Order directly to Hostinger [https://eur-lex.europa.eu/eli/reg/2023/1543/oj/eng]. Germany is listed as ready to issue EPOCs only, not EPOC-PRs, and Lithuania is not on the Commission's readiness list at all ([Commission readiness list, 6 Nov 2026](https://commission.europa.eu/document/download/5b3c2ee0-4055-4694-82c3-dc265cd6f108_en?filename=Information%20on%20Member%20States%20ready%20to%20issue%20and%20or%20receive%20EPOCs%20and%20EPOCS-PR.pdf)). Orders to a provider in a state that is not technically ready go by the Commission's contingency means (secure e-mail). Lithuania's transposition of Directive 2023/1544 is reported as incomplete [https://emerging-europe.com/the-eus-e-evidence-framework/] [unverified].

### 6. Evidence of real practice

- **Tycoon2FA, 4 March 2026.** Lithuania's Criminal Police Bureau carried out "seizure of infrastructure and other operational measures". The investigation "began after intelligence was shared by Trend Micro" and was passed on through Europol EC3 [https://www.europol.europa.eu/media-press/newsroom/news/global-phishing-service-platform-taken-down-in-coordinated-public-private-action]. This is a private-sector tip that reached Lithuania via Europol, not by direct intake.
- **LabHost, 18 April 2024.** "Lithuania Police" is listed as a participant, with no detail on what it did [https://www.europol.europa.eu/media-press/newsroom/news/international-investigation-disrupts-phishing-service-platform-labhost].
- I found no case where a private foreign reporter's direct complaint led Lithuania to open a case on phishing hosting [unverified].

### 7. Verdict

**Caveat on Hostinger (checked 2026-11-17).** For customers in EU countries and "any other country" not in the listed groups, the contracting party is **Hostinger International Limited, 61 Lordou Vironos str., 6023 Larnaca, Cyprus**. UK customers contract with Hostinger UK Limited. Group 1 countries contract with HOSTINGER PTE LTD (Singapore) and Group 2 countries with HOSTINGER Global S.à r.l. (Luxembourg). Governing law is Luxembourg ([Hostinger Universal Terms, Section 2 and 22](https://www.hostinger.com/legal/universal-terms-of-service-agreement)). The abuse policy accepts EU orders at abuse@ or compliance@hostinger.com "in English, Lithuanian, or Greek" ([abuse policy](https://www.hostinger.com/legal/abuse-policy)).

What this means:

- Lithuania is where Hostinger's AS and operations sit. The subscriber and payment data of a phishing customer is contractually held by a Cypriot, Singaporean, Luxembourgish or UK entity, depending on where the customer claims to live.
- The physical server may sit in any Hostinger data centre. Which locations that covers is [unverified]: I did not check Hostinger's data-centre list.
- A Lithuanian domestic order reaches the data only if the Lithuanian company has it in its possession or control [unverified].
- For a German prosecutor this matters less: an EPOC goes to whatever addressee Hostinger designated for the Regulation.

**Chance of opening a case:** low to moderate, mostly formal. The legal duty to investigate (Arts. 2, 166, 168) means a signed, identified report must at least be registered and decided, with a reasoned refusal if declined. But phishing.support cannot use ePolicija without Lithuanian eID, has no victim standing, and gets no case number unless it files by post with a signature or with a qualified e-signature. The likely outcome is an investigation opened, nobody identified, and the case suspended.

**Better route:** the Bavarian ZCB or the competent German prosecutor sends a European Production Order directly to Hostinger, and has preservation requested through the BKA 24/7 point to the Lithuanian Criminal Police Bureau (Budapest Art. 29) until Germany can issue EPOC-PRs. For a joint case, the Bavarian authority adds spontaneous information to Lithuania (Art. 26 Budapest / Art. 7 EU MLA Convention 2000), an EIO, or coordination through Eurojust and Europol EC3. That is the route Tycoon2FA took. In parallel, phishing.support files an e-mailed report to cyberpolice@policija.lt with a qualified e-signature, and sends takedown reports to Hostinger abuse and CERT-LT.


---

## Netherlands

### 1. Jurisdiction

- **Territorial scope:** art. 2 Sr: *"De Nederlandse strafwet is toepasselijk op ieder die zich in Nederland aan enig strafbaar feit schuldig maakt."* [https://wetten.overheid.nl/BWBR0001854/] The statute does not define the place of the offence. Courts apply the ubiquity doctrine, under which the place of the conduct, the place where an instrument worked, and the place where the effect occurred all count as places of the offence. Example: Rb. Den Haag, ECLI:NL:RBDHA:2016:8411 [https://uitspraken.rechtspraak.nl/details?id=ECLI%3ANL%3ARBDHA%3A2016%3A8411]. The Supreme Court's "leer van het instrument" (HR *Azewijnse Paard*) and the explicit rule that a phishing server in NL creates jurisdiction are [unverified]: I did not find a primary HR ruling about servers. Art. 2 does not depend on the victims' nationality, so German-only victims do not block jurisdiction. Art. 5 Sr, which covers offences abroad against Dutch nationals, is not needed here [https://wetten.overheid.nl/BWBR0001854/].
- **Substantive offences** (all at [https://wetten.overheid.nl/BWBR0001854/]):
  - art. 138ab Sr, *computervredebreuk*: intrusion includes access gained *"door het aannemen van een valse hoedanigheid"*. Up to 2 years, or 4 years if data is then copied.
  - art. 139d(2)(a)–(b) Sr: making, possessing or distributing a tool designed for 138ab offences, or possessing or distributing *"een computerwachtwoord, toegangscode of daarmee vergelijkbaar gegeven"*. This covers phishing kits and harvested credentials.
  - art. 326 Sr, *oplichting*: explicitly covers inducing someone *"tot het ter beschikking stellen van gegevens"*. Up to 4 years.
  - art. 231b Sr: misuse of another person's identifying data (identity fraud).
  - art. 232(2) Sr: using or possessing a non-cash payment instrument obtained through crime.
  - art. 420bis Sr: money laundering.

### 2. Intake

- **Case-opening channels (police/OM):**
  - Anyone may report: art. 161 Sv, *"Ieder die kennis draagt van een begaan strafbaar feit is bevoegd daarvan aangifte … te doen"*. Art. 163 Sv allows oral or written reports, in person or by a written power of attorney. Reporters who do not speak Dutch may use another language (lid 3), and the reporter gets a copy of the report (lid 5) [https://wetten.overheid.nl/BWBR0001903/].
  - In practice, Dutch police turn foreign reporters away. On the page for victims abroad of a Dutch citizen or company, the police say they cannot help and do not process e-mails or social media requests. Victims must report to their local police, who then send a request to the Netherlands [https://www.politie.nl/en/information/i-live-abroad-and-i-became-the-victim-of-a-crime-committed-by-a-dutch-citizen-or-company.html]. For potential criminal behaviour such as fraud by a Dutch citizen or company, the police say it is "not yet possible" to report it from outside the Netherlands [https://www.politie.nl/en/information/i-want-to-report-a-dutch-citizen-or-company.html].
  - Online reporting requires DigiD and covers only certain offences [unverified on a politie.nl primary page; secondary: https://veiliginternetten.nl/thema/basisbeveiliging/cybercrime/waar-kan-ik-cybercrime-melden/].
- **Meld Misdaad Anoniem (M.):** an anonymous tip line, not an aangifte. Web form or phone; from abroad dial 00800 0800 7000. Its listed categories do not include cybercrime. Whether attachments can be uploaded or a case number is given is not stated on the homepage [https://www.meldmisdaadanoniem.nl/].
- **Not case-opening:** the Fraudehelpdesk (already known) and NCSC-NL/CERT channels serve takedown and advice only.

### 3. Legality vs opportunity principle

- The Netherlands follows the opportunity principle. Under art. 167(2) Sv, *"Van vervolging kan worden afgezien op gronden aan het algemeen belang ontleend"* [https://wetten.overheid.nl/BWBR0001903/]. There is no duty to investigate.
- Under art. 12 Sv, only a *rechtstreeks belanghebbende* can complain to the Court of Appeal about non-prosecution [https://wetten.overheid.nl/BWBR0001903/]. A foreign tipster without a stake would hardly qualify.
- The OM cybercrime guideline (Stcrt. 2018, 3271) covers sentencing only, not intake thresholds [https://zoek.officielebekendmakingen.nl/stcrt-2018-3271.html]. I found no published minimum-loss threshold or policy for foreign victims.
- Prioritisation follows solvability and impact. Team High Tech Crime takes the most complex and international cases [https://open.overheid.nl/documenten/dpc-a802d862b88513f02f77a8a3400a2269326b9ba6/pdf; secondary].

### 4. Domestic powers (Sv, [https://wetten.overheid.nl/BWBR0001903/])

- **Art. 126nc:** for any *misdrijf*, an ordinary police officer can demand identifying data (name, address, date of birth, "administratieve kenmerken") from anyone who processes data other than for personal use. This covers a hoster or Realtime Register's customer records.
- **Art. 126na:** for any *misdrijf*, an officer can demand user data (name, address, number and type of service) from a communication service provider.
- **Art. 126nd:** a prosecutor (OvJ) can demand any stored data, including payment records, for art. 67(1) offences. Art. 67(1)(b) lists 138ab and 139d(1)–(2); 326 qualifies through the 4-year limit. **Art. 126ne** extends such demands to future data in 4-week periods.
- **Art. 126n:** a prosecutor can demand traffic data, including IP logs, from communication providers.
- **Art. 126ng(2):** content stored for a customer at a provider requires a "serious breach of the legal order" and an urgent need. The full approval text (for example, the role of the rechter-commissaris) was truncated in my source, so it is not confirmed.
- **Preservation:** art. 126ni lets a prosecutor order data to be *"bewaard en beschikbaar gehouden"* for up to 90 days. Thresholds: art. 67 offence, serious breach, and urgency.
- **No retention obligation:** the Wet bewaarplicht telecommunicatiegegevens was set aside on 11 March 2015 (ECLI:NL:RBDHA:2015:2498) [https://uitspraken.rechtspraak.nl/details?id=ECLI%3ANL%3ARBDHA%3A2015%3A2498]. Hosters have no statutory KYC duty; the government prefers an EU-level duty [https://www.tweedekamer.nl/kamerstukken/brieven_regering/detail?id=2026Z15776&did=2026D35400].
- **Speed:** the deadline is set in each demand (126nc(4)(c)). I found no statutory turnaround time [unverified].

### 5. Cooperation

- **Budapest Convention:** signed 23/11/2001, ratified 16/11/2006, in force 01/03/2007 [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185].
- **Second Additional Protocol:** signed 12/05/2022, not ratified. Only 4 states have ratified, so it is not yet in force [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224].
- **EU e-Evidence Regulation 2023/1543:** applies, and Germany and the Netherlands are both bound. A German prosecutor or court can send a European Production Order directly to a Dutch hoster or registrar. Germany is listed as ready to issue EPOCs only, not EPOC-PRs, and the Netherlands is not on the Commission's readiness list ([6 Nov 2026](https://commission.europa.eu/document/download/5b3c2ee0-4055-4694-82c3-dc265cd6f108_en?filename=Information%20on%20Member%20States%20ready%20to%20issue%20and%20or%20receive%20EPOCs%20and%20EPOCS-PR.pdf)).
- **EIO Directive 2014/41/EU:** applies between DE and NL [unverified primary check].
- **Bilateral:** treaty of 30 August 1979 (Wittem) supplementing the ECMA (Vertrag zur Ergänzung des EuRhÜbk). German approval law: EuRHiÜbkVtrNLDG [https://www.gesetze-im-internet.de/eurhi_bkvtrnldg/EuRHi%C3%9CbkVtrNLDG.pdf]. Published at BGBl. 1981 II S. 1158 according to RiVASt [https://www.gesetze-bayern.de/Content/Pdf/RiVASt-ANL_2?all=False].
- **24/7 contact point:** at the National Police (High Tech Crime / LIRC) [https://www.coe.int/en/web/octopus/country-wiki-ap/-/asset_publisher/CmDb7M4RGb4Z/content/netherlands/pop_up].

### 6. Evidence of real practice

- **Feb 2025, Amsterdam:** the cybercrime team seized 127 servers of bulletproof hoster ZServers/XHost under art. 138ab. The case started from the police's own observation of the hoster's ads, not from a tip [https://www.politie.nl/nieuws/2025/februari/13/politie-amsterdam-ontmantelt-digitaal-crimineel-netwerk-127-servers-offline-gehaald.html].
- **Oct 2026, Limburg:** Team Cybercrime Midden-Nederland seized a bulletproof hoster's servers, which hosted phishing among other things. The police obtained data on more than 3,000 customers, in parallel with the FBI and German police [https://www.politie.nl/nieuws/2026/oktober/28/03-internationale-actie-tegen-bulletproof-hoster.html].
- **May 2026:** two sellers of phishing panels "gericht op banken uit heel Europa" were arrested and then surrendered to Belgium [https://www.politie.nl/nieuws/2026/mei/22/pl1100---twee-mannen-aangehouden-voor-phishing.html].
- **July 2021, "Fraud Family":** a Team High Tech Crime case triggered by a private-sector tip from Group-IB [https://group-ib.com/media/fraud-family]. The police's own press release on the tip is [unverified].

### 7. Verdict

The legal basis is strong. Dutch criminal law reaches phishing infrastructure in the Netherlands even when all victims are German, and Dutch officers can quickly compel subscriber, payment and log data. The intake is not: the police say they do not process e-mails, they send foreigners back to their local police, and the OM may decline under the opportunity principle. A direct report from phishing.support is very unlikely to open a case. At most it could feed intelligence via M., and even that is [unverified].

The better route goes through Germany:

1. Report the campaign to the Bavarian authorities (ZCB or the LKA).
2. The German prosecutor issues a European Production Order directly to the Dutch hoster or registrar, or uses an EIO. Preservation goes via the 24/7 network (Budapest Art. 29), where the Netherlands can use art. 126ni Sv.
3. In parallel, Germany sends spontaneous information to the Dutch LIRC or Team High Tech Crime (Art. 26 Budapest / Art. 7 EU MLA Convention 2000), or via Europol EC3 when the campaign involves several countries.

Pressure from abuse reports and the Dutch hosting community's KYC efforts is aimed at takedown, not prosecution.


---

## United Kingdom (England & Wales; hoster 20i)

### 1. Jurisdiction

- **Fraud Act 2006 offences are covered.** Fraud (s.1), possessing articles for fraud (s.6) and making or supplying them (s.7) are "Group A offences" under CJA 1993 s.1(2). Under s.2(3), a person "may be guilty of a Group A offence if any of the events which are relevant events … occurred in England and Wales". Under s.2(2), the place of the other events is disregarded. For fraud, the relevant events include where the gain or loss occurs (s.2(1A)). [https://www.legislation.gov.uk/ukpga/1993/36/section/1] [https://www.legislation.gov.uk/ukpga/1993/36/section/2]
- **The offences themselves.** s.6 covers having "in his possession or under his control any article for use in … any fraud" (maximum 5 years). s.7 covers making, adapting or supplying such articles (maximum 10 years). [https://www.legislation.gov.uk/ukpga/2006/35/section/6] [https://www.legislation.gov.uk/ukpga/2006/35/section/7]
- **Does a phishing kit on a UK server count?** A kit sitting on a UK server is arguably a relevant event (control or making) in England and Wales. So is a false representation made from a UK-hosted page. I found no primary authority confirming that hosting alone is enough. [unverified, interpretation]
- **Computer Misuse Act 1990 s.4–5.** A "significant link with domestic jurisdiction" is required. Under s.5(2)–(3), that means the accused was in the UK, or the computer accessed or impaired was in the UK. A phishing server is the offender's tool, not the victim's computer, so CMA s.1 jurisdiction does not follow from UK hosting alone. It does follow when the UK site was itself hacked to host the kit, which is common on shared hosting. CMA s.3A makes supplying tools for CMA offences an offence. [https://www.legislation.gov.uk/ukpga/1990/18/section/4] [https://www.legislation.gov.uk/ukpga/1990/18/section/5] [https://www.legislation.gov.uk/ukpga/1990/18/section/3A]
- **Money laundering.** POCA 2002 s.340(2): criminal conduct includes conduct that "would constitute an offence in any part of the United Kingdom if it occurred there". German-victim proceeds handled in the UK are therefore criminal property. [https://www.legislation.gov.uk/ukpga/2002/29/section/340]
- **Foreign victims are no bar.** No statute requires UK victims for any of these offences.

### 2. Intake

- **Report Fraud (City of London Police; replaced Action Fraud on 4 Dec 2025).** This is the only national police route for fraud and cyber crime reports.
  - It offers online reporting as a guest or registered user, and a phone line on +44 300 123 2040 from abroad. [https://www.reportfraud.police.uk/null/Reporting-fraud-and-cyber-crime/]
  - It addresses "individuals and businesses" who "live in England, Wales or Northern Ireland". [https://www.reportfraud.police.uk/]
  - Reports go to a Crime Analysis team, which "assess[es], analyse[s] and send[s] them to police forces". [https://www.reportfraud.police.uk/who-reports-fraud-to-us]
  - English only.
  - Not stated: whether a foreign non-victim may file, whether attachments are accepted, and whether a crime reference number is issued. [unverified]
  - Where no crime is recorded, an "information report" is made under the Home Office Counting Rules for fraud. [https://assets.publishing.service.gov.uk/media/645b7b87479612000fc29318/nfib-fraud-april-2023.pdf]
  - In practice this is the realistic way to lodge third-party intelligence, but it is not a complaint that opens a case.
- **Other police channels.** Local forces (101) are for UK residents. The NCA takes no public crime reports; its "report a crime" page returned 404. Crimestoppers takes anonymous intelligence. [unverified]
- **DCPCU (Dedicated Card and Payment Crime Unit).** Funded by the banking industry and run by City of London Police, the Met and UK Finance. It acts on intelligence from banks, not from the public. [https://www.ukfinance.org.uk/press/press-releases/banking-industry-funded-police-unit-cracks-down-on-covid-19-scams]
- **Takedown/CERT channels (not case-opening).** NCSC (already known). 20i publishes no law-enforcement or abuse procedure that I could find. Its privacy policy states hosting backups are kept 12 months and web hosting data 30 days. [https://www.20i.com/legal/20i-ltd-privacy-policy]

### 3. Legality vs opportunity

- **Opportunity principle applies.** Code for Crown Prosecutors §3.2: police "decid[e] how to deploy their resources", including whether to start an investigation. §3.3: prosecutors cannot direct police. §4.10: "It has never been the rule that a prosecution will automatically take place". [https://www.cps.gov.uk/publication/code-crown-prosecutors]
- **Overseas suspects.** Report Fraud says it is "not always possible for every report to be investigated … if a suspect is located overseas". [https://www.reportfraud.police.uk/victim-resources/]
- **Screening out.** Counting Rules outcome 19A/19B means no viable lines of enquiry at assessment. [https://carcrime.uk/wp-content/uploads/2026/01/hocr-complete-july-22.pdf, secondary copy]
- **No loss threshold found.** I found no published minimum-loss threshold. [unverified]

### 4. Domestic powers

- **Communications data, IPA 2016 Part 3.** Authorised by the Investigatory Powers Commissioner (s.60A) or a designated senior officer (s.61).
  - Subscriber/entity data: any crime.
  - Events data (logs, IPs): "serious crime" only (s.60A(8)), defined as an offence carrying 12 months or more (s.86(2A)). Fraud Act ss.6/7 qualify.
  - No court order is needed.
  - [https://www.legislation.gov.uk/ukpga/2016/25/section/60A] [https://www.legislation.gov.uk/ukpga/2016/25/section/86] [https://www.legislation.gov.uk/ukpga/2016/25/section/261]
- **Content and business records (incl. payment data).** A PACE 1984 Sch.1 production order from a circuit judge. Condition: reasonable grounds that "an indictable offence has been committed". Confidential business records are "special procedure material" (s.14). [https://www.legislation.gov.uk/ukpga/1984/60/schedule/1] [https://www.legislation.gov.uk/ukpga/1984/60/section/14]
- **Preservation.**
  - No statutory preservation order. Per the CoE country sheet: requests are executed if a provider "voluntarily complies", which providers "normally" do "but it is not guaranteed".
  - Fallback is IPA s.60A. Handled "where possible … within 24 hours".
  - [https://rm.coe.int/international-coop-annex-to-cw-uk/16809f9865]
- **Retention.** Only by retention notice to specific operators (IPA s.87). No general duty, and 20i is not known to be notified. [https://www.legislation.gov.uk/ukpga/2016/25/section/87]

### 5. Cooperation

- **Budapest Convention.** Ratified 25 May 2011, in force for the UK 1 Sep 2011. [https://www.coe.int/en/web/cybercrime/activities1/-/asset_publisher/LvcD1GIJBu1K/content/united-kingdom-ratified-the-convention-on-cybercrime?inheritRedirect=false]
- **Second Additional Protocol (CETS 224).** UK signed 30 Nov 2022, Germany 27 Jan 2023. Neither has ratified (chart status 17 Nov 2026). [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224]
- **24/7 point of contact.** NCA National Cyber Crime Unit. [https://rm.coe.int/international-coop-annex-to-cw-uk/16809f9865]
- **EU e-Evidence Regulation.** Does not apply; the UK is a third country.
- **Germany–UK legal basis.** The EU–UK TCA Part 3 Title VIII (Arts 633–642) supplements the 1959 European Convention on Mutual Assistance and its Protocols. Urgent requests and spontaneous information can also go via Europol or Eurojust. [https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:22021A0430(01)]
- **Art. 21 ECMA is not available.** The UK reserved the right not to apply Art. 21 (laying of information) [https://treaties.fcdo.gov.uk/data/Library2/pdf/1992-TS0024.pdf]. A German Verfolgungsersuchen therefore has to rest on the TCA or be sent as spontaneous information.
- **UK central authority.** UKCA (Home Office). Requests in English; no diplomatic channel required. [https://rm.coe.int/international-coop-annex-to-cw-uk/16809f9865]
- **Not relevant for UK hosters.** The Crime (Overseas Production Orders) Act 2019 and the UK–US Data Access Agreement cover outbound UK requests to foreign providers.

### 6. Practice

- **LabHost (Met-led, 19 countries).** 37 arrests in April 2024. [https://www.europol.europa.eu/media-press/newsroom/news/international-investigation-disrupts-phishing-service-platform-labhost]
  - The case began in June 2022 on intelligence from the Cyber Defence Alliance, a financial-industry body. [https://cyberdefencealliance.org/operation-stargrew-targeting-labhost-a-global-phaas-platform/; Met primary not retrieved, unverified]
  - Developer Zak Coyne was jailed for 8.5 years for making or supplying articles for fraud. [https://www.cps.gov.uk/cps/news/man-who-created-one-stop-shop-phishing-jailed]
- **Ollie Holman (City of London Police).** Sold 1,052 phishing kits targeting 69 institutions in 24 countries; 7 years in July 2025. Shows the UK prosecutes global-victim phishing under s.7. What triggered the case is not stated. [https://www.cps.gov.uk/cps/news/university-student-who-sold-phishing-kits-fraudsters-jailed]
- **Pattern.** Every case found started from organised industry bodies or police partners. None started from a foreign individual's report about a single hosted site.

### 7. Verdict

- **Legal basis exists, case opening is unlikely.** The law would allow it: Fraud Act ss.6/7 via CJA 1993, and CMA where a UK site was hacked. UK powers are strong and fast, notably IPA entity and events data without a court order.
- **But intake and discretion work against it.** There is no case-opening channel aimed at foreign third parties, the opportunity principle applies, and triage deprioritises cases with foreign suspects and no UK victims. A direct report would most likely end as an NFIB/Report Fraud information report. Chance of a case: low (no figures exist; this is an assessment).
- **Better route:** a German Staatsanwaltschaft/LKA Bayern request through the NCA 24/7 point for voluntary preservation at 20i, followed by MLA (TCA Title VIII) or spontaneous information under Budapest Art. 26 and Europol/J-CAT. Big campaigns, such as a phishing kit seller or PhaaS, could go to UK industry bodies (Cyber Defence Alliance, UK Finance/DCPCU) that already feed UK police.
- **Act quickly.** 20i's 30-day hosting data window makes speed critical. [https://www.20i.com/legal/20i-ltd-privacy-policy]


---

## France

### 1. Jurisdiction

- **Territorial rule.** Art. 113-2 Code pénal: « La loi pénale française est applicable aux infractions commises sur le territoire de la République. L'infraction est réputée commise sur le territoire de la République dès lors qu'un de ses faits constitutifs a eu lieu sur ce territoire. » [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006417187]
  - **Applied to phishing (my analysis):** a phishing page served from a French host is a manœuvre frauduleuse under art. 313-1. A credential-harvesting backend in France is where the data is collected or misused. Both should count as a "fait constitutif" in France, even when every victim is German. [analysis; no Cour de cassation ruling on "server location alone" found — unverified]
- **Victim rule, which does not help here.** Art. 113-2-1 (loi 2016-731) deems an offence committed in France when it is done through an electronic communications network « au préjudice d'une personne physique résidant sur le territoire de la République ou d'une personne morale dont le siège se situe » in France. It is a victim-residence rule, so it gives no extra basis when the victims are German. [https://www.legifrance.gouv.fr/search/code?tab_selection=code&searchField=ALL&query=113-2-1+code+p%C3%A9nal&page=1&init=true ; text via https://www.droitcybercrime.eu/wiki/Code_p%C3%A9nal/113-2-1]
- **Substantive offences:**
  - art. 323-1 (illegal access to or staying in an automated data processing system, "STAD") [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000047052655]
  - art. 323-3 (illegal extraction or holding of data) [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000030939448]
  - art. 323-3-1 (holding, offering or making available, without legitimate reason, a programme designed for offences under 323-1 to 323-3; this would reach phishing kits used for credential theft) [https://justice.pappers.fr/loi/LEGITEXT000006070719/article/LEGIARTI000028345220]
  - art. 323-3-2 (knowingly running an online platform that enables manifestly illicit transactions; added by LOPMI 2023, current version) [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000051742358]
  - art. 313-1 escroquerie, art. 226-4-1 usurpation d'identité, art. 324-1 money laundering [text not checked on Légifrance in this session — unverified]

### 2. Intake

**Case-opening channels:**

- **Written complaint to the procureur de la République.** Art. 40 CPP: the procureur « reçoit les plaintes et les dénonciations et apprécie la suite à leur donner » [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006574933].
  - Anyone can send one by letter, including a non-victim (a « dénonciation »), against X, with attachments. Recommended form: registered letter with acknowledgment of receipt. Language: French (official translation not required but practically necessary) [unverified].
  - The Ministry of Justice confirms a complaint is possible even when the author is abroad [https://www.justice.fr/fiche/escroquerie].
  - The best addressee is section J3 (cyber) of the Parquet de Paris. Art. 706-72-1 CPP gives Paris nationwide jurisdiction, concurrent with local parquets, for STAD offences (arts. 323-1 to 323-4-1) [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032633870]. Legifrance notes it is repealed by Ordonnance 2025-1091 with effect from 2029-01-01 (recodification) [same URL, search excerpt].
  - J3 handles "complex" cases; local parquets keep the rest [https://www.senat.fr/rap/r19-613/r19-613_mono.html].
  - A case number and a reasoned notice of closure go only to plaignants and identified victims (art. 40-2) [unverified for dénonciateurs].
- **THESEE (online complaint).** It is victim-only, in the complainant's own name, and requires FranceConnect authentication [https://www.service-public.gouv.fr/particuliers/vosdroits/F47157]. It is not usable by phishing.support.
- **PHAROS (internet-signalement.gouv.fr).** Staffed by police and gendarmes. Illegal content is classified and passed to an investigation unit, possibly leading to an investigation under a prosecutor. Contact details are optional, and « Sauf exception, Pharos ne vous contactera pas ». Content « conçu à l'étranger » goes to Interpol [https://www.masecurite.interieur.gouv.fr/fr/demarches-en-ligne/portail-officiel-signalement-contenus-illicites-internet-pharos]. It is a public-content reporting desk with no feedback and no case number, and phishing e-mails are routed to Signal Spam [unverified].

**Takedown and assistance only (no case opened):** cybermalveillance.gouv.fr (victim assistance), Signal Spam. Neither is a police channel [unverified on primary pages].

**OFAC** (Office anti-cybercriminalité): created by décret 2023-1083, in force 2023-12-01, replacing OCLCTIC [https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000048458223]. It is an investigation service with no public intake.

### 3. Legality vs opportunity

- France follows the opportunity principle. Art. 40-1 CPP lets the procureur prosecute, use an alternative to prosecution, or close the case (« classement sans suite ») [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033611483/2016-12-11]. There is no duty to investigate.
- J3 is small: 5 magistrates in 2024 (Cour des comptes) [https://www.ccomptes.fr/sites/default/files/2025-06/20250616-S2025-0602-Reponse-de-l-Etat-aux-cybermenaces-sur-systemes-d'information-civils.pdf]. It focuses on "haut du spectre" cases [https://www.assemblee-nationale.fr/dyn/opendata/CRCANR5L17S2025PO866672N011.html].
- I found no published loss threshold and no policy on foreign-victim cases [not found].

### 4. Domestic powers

- **Production orders to the host.** Requisitions under art. 60-1 CPP (flagrance) and art. 77-1-1 (preliminary inquiry). They can be issued "par tout moyen" to any person or body holding relevant information, including computer data. Refusing without a legitimate reason carries a €3,750 fine [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000047052970]. These reach subscriber, payment and log data. No statutory deadline found; OVHcloud reports a median acknowledgement time of 8 hours for French orders in 2024 [https://corporate.ovhcloud.com/sites/default/files/2025-04/rapport_de_transparence_dsa_ovhcloud_2025.pdf].
- **Preservation.** Art. 60-2 al. 2 (and 77-1-2) CPP: on the procureur's request and with prior authorisation of the juge des libertés et de la détention (JLD), the police can order preservation of content for up to one year [https://www.legifrance.gouv.fr/loda/article_lc/LEGIARTI000045292575/2025-02-24]. Art. L34-1 III bis CPCE adds an « injonction de conservation rapide » [https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000028345210/].
- **Retention by hosts.** Décret 2021-1362, under LCEN art. 6 [https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000044228912]. Per secondary sources: identité civile 5 years, account and payment data 1 year, technical/IP data 1 year [unverified on Légifrance; https://www.simonnetavocat.fr/comment-identifier-un-internaute-anonyme/].

### 5. Cooperation

- **Budapest Convention:** signed 2001-11-23, ratified 2006-01-10, in force 2006-05-01 [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185].
- **Second Additional Protocol:** signed 2023-01-27, not ratified [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224].
- **EU e-Evidence Regulation 2023/1543:** applies, so a German prosecutor can send a European Production Order directly to OVHcloud. Germany is listed as ready to issue EPOCs only, not EPOC-PRs, and France is not on the Commission's readiness list ([6 Nov 2026](https://commission.europa.eu/document/download/5b3c2ee0-4055-4694-82c3-dc265cd6f108_en?filename=Information%20on%20Member%20States%20ready%20to%20issue%20and%20or%20receive%20EPOCs%20and%20EPOCS-PR.pdf)).
- **Other instruments:** European Investigation Order (Directive 2014/41) and EU MLA Convention 2000, plus the Germany–France supplementary treaty of 1974-10-24 to the European MLA Convention 1959 [https://www.verwaltungsvorschriften-im-internet.de/bsvwvbund_01012017_IIB6935088.htm].
- **24/7 contact point:** exists. It was OCLCTIC [https://www.senat.fr/rap/r19-613/r19-6137.html]; now presumably OFAC [unverified]. France is a heavy user of the network (268 requests in 2019) [https://rm.coe.int/t-cy-2020-16-bc-benefits-rep-provisional/16809ef6ac].

### 6. Real practice

- **PlugX (2024):** J3 opened a preliminary investigation « à la suite d'un signalement de la société Sekoia » and assigned it to the gendarmerie's C3N [https://www.tribunal-de-paris.justice.fr/sites/default/files/2024-07/2024-07-24%20-%20CP%20d%C3%A9mant%C3%A8lement%20botnet%20d'espionnage%20plugX.pdf]. This is a private-sector tip, but from a French company and with French victims.
- **SocksEscort (2026):** J3 opened the case in June 2024 after US authorities reported that part of the infrastructure was in France [franceinfo, secondary: https://www.franceinfo.fr/internet/securite-sur-internet/cyberattaques/cybercriminalite-un-reseau-de-proxys-illegaux-demantele-lors-d-une-vaste-operation-judiciaire-internationale-annonce-le-parquet-de-paris_7863323.html]. Eurojust confirms servers in France and the involvement of J3, JUNALCO and OFAC [https://www.eurojust.europa.eu/news/servers-used-cybercrime-around-world-taken-down]. This is the closest precedent for "foreign tip about French-hosted infrastructure leads to a French case", but the tip came from law enforcement.
- **Qakbot (2023):** 6 of 170 C2 servers were in France [https://www.cybermalveillance.gouv.fr/tous-nos-contenus/actualites/victimes-qbot].
- I found no case started by a foreign private reporter about phishing pages.

### 7. Verdict

**Legal basis:** French jurisdiction over French-hosted phishing infrastructure is legally solid under art. 113-2, and the procureur must receive any dénonciation.

**Odds of a direct report from phishing.support:**

- A French-language letter to J3 is possible. Under the opportunity principle, a small J3 and no French victims, it will most likely be closed or forwarded without feedback.
- PHAROS gives no feedback and sends foreign-made content to Interpol.
- The realistic chance is low, unless the report bundles many campaigns on OVHcloud or other French infrastructure into a clear, large-scale case. J3 is known to act on technical tips (Sekoia).

**Better route:** the Bavarian prosecutor (ZCB Bamberg):

- issues a European Production Order directly to OVHcloud (fastest; no French court needed), or an EIO, and asks for preservation via the 24/7 network (Budapest Art. 29);
- sends spontaneous information (Art. 26 Budapest / Art. 7 EU MLA Convention 2000) to J3 Paris through Eurojust or the 24/7 network so a parallel French case can open;
- uses Europol for coordination.

phishing.support can additionally file a parallel courtesy dénonciation to J3, citing the German case number.


---

## Ireland

### 1. Jurisdiction

- **The strongest hook is the Criminal Justice (Theft and Fraud Offences) Act 2001, s.9 (unlawful use of a computer).** It covers a person who "dishonestly, whether within or outside the State, operates or causes to be operated a computer within the State with the intention of making a gain … or of causing loss to another". The maximum is 10 years. A phishing kit running on a server in Ireland fits these words even when the operator and all victims are abroad. [https://www.irishstatutebook.ie/eli/2001/act/50/section/9/enacted/en/html] No Irish case applying s.9 to foreign-only victims was found. [unverified]
- **s.6 of the same Act (making gain or causing loss by deception, max 5 years)** has no express extraterritorial clause. Its reach when the deceived victims are in Germany depends on the common-law territoriality rule. [https://www.irishstatutebook.ie/eli/2001/act/50/section/6/enacted/en/html] [extent unverified]
- **Criminal Justice (Offences Relating to Information Systems) Act 2017** covers:
  - s.2: accessing a system "by infringing a security measure".
  - s.6: producing, procuring or making available programs or "computer password … access code" for use in s.2–5 offences. This is the phishing-kit and credential-harvesting offence.
  - s.10(1): jurisdiction over acts "committed, whether in whole or in part" (a) in the State against a foreign system, or (b) from outside the State against a system *in the State*. Remote use of an Irish server is arguably an act "in part" in the State, but no case law was found. [unverified]
  [https://www.irishstatutebook.ie/eli/2017/act/11/section/2/enacted/en/html] [https://www.irishstatutebook.ie/eli/2017/act/11/section/6/enacted/en/html] [https://www.irishstatutebook.ie/eli/2017/act/11/section/10/enacted/en/html]
- **Money laundering:** Criminal Justice (Money Laundering and Terrorist Financing) Act 2010 s.7 (in the State, max 14 years). s.8 covers conduct abroad only in narrow cases, such as Irish nationals or residents, or a refused extradition or EAW. [https://www.irishstatutebook.ie/eli/2010/act/6/section/7/enacted/en/html] [https://www.irishstatutebook.ie/eli/2010/act/6/section/8/enacted/en/html]

### 2. Intake

- **Police (opens a case):** An Garda Síochána. For fraud, the public is told to report "in the first instance to your local Garda station". Cases that are "unsuitable for local attention" are forwarded to the Garda National Economic Crime Bureau (GNECB), which has no published direct fraud intake. [https://www.garda.ie/en/crime/fraud/which-unit-within-an-garda-siochana-investigates-fraud-.html] For cybercrime, complaints go first to the local station; the Cyber Crime Bureau's phone is +353 1 666 3708. [https://www.garda.ie/en/crime/cyber-crime/cyber-crime-awareness.html]
- **Online reporting** covers only theft of property up to €1,000. Another Garda page says €500, so the two pages disagree. It is not a fraud or cybercrime channel. [https://www.garda.ie/en/victim-services/reporting-a-crime-faqs/can-i-report-crime-online-.html]
- **No foreign channel:** I found no channel for foreign third-party reporters, no published attachment upload, and no promise of feedback. Language is English (or Irish). Postal fallback: Garda HQ, Phoenix Park, Dublin 8, D08 HN3X. [same fraud page]
- **Anonymous tip line:** Garda Confidential, 1800 666 111. [https://www.garda.ie/en/crime/fraud/which-unit-within-an-garda-siochana-investigates-fraud-.html]
- **CERT (no case opened):** NCSC-IE/CSIRT-IE serves "Irish Government and Critical National Infrastructure" constituents. It sends cybercrime victims to the Garda. Address: certreport@ncsc.gov.ie, which accepts forwarded emails with attachments. [https://www.ncsc.gov.ie/incidentreporting/]

### 3. Legality vs opportunity

- **No legality principle (no statutory duty to investigate).** Both the Garda and the DPP work on discretion. [Garda duty statute: unverified]
- **DPP two-stage test:** is the evidence strong enough, and is prosecution "in the public interest"? Factors include seriousness and the impact on the victim. [https://www.dppireland.ie/victims-witnesses/how-we-make-prosecution-decisions/]
- **Thresholds:** I found no published loss threshold or policy for cybercrime with foreign victims. [unverified]
- **Resources:** The Council of Europe (CoE) profile says urgent requests are "prioritised by facts and risk". [https://www.coe.int/en/web/octopus/-/ireland]

### 4. Domestic powers

- **Production orders:** 2001 Act s.52 lets a District Court judge order production of, or access to, material for offences carrying 5+ years. For computer data, it is produced in "visible and legible" form, "notwithstanding any … obligation as to secrecy". [https://www.irishstatutebook.ie/eli/2001/act/50/section/52/enacted/en/html] Production orders also exist under Criminal Justice Act 2011 s.15 and Criminal Justice Act 1994 s.63. [https://www.coe.int/en/web/octopus/-/ireland]
- **Search warrant:** 2017 Act s.7, including the power to seize and operate computers. [https://www.irishstatutebook.ie/eli/2017/act/11/section/7/enacted/en/html]
- **Speed:** no statutory deadline for domestic orders. [unverified]
- **Retention:** The Communications (Retention of Data) Act 2011 as amended in 2022 applies only to providers of "publicly available electronic communications service or … network". Pure web hosters are therefore likely outside it. [https://www.irishstatutebook.ie/eli/2011/act/3/section/1/enacted/en/html]
  - Where it applies: user data for 1 year (s.3), [https://www.irishstatutebook.ie/eli/2022/act/25/section/3/enacted/en/html] and urgent preservation of Schedule 2 data (s.7B). [https://www.irishstatutebook.ie/eli/2022/act/25/section/7] [s.7B wording unverified]
- **No general preservation order yet.** The CoE says preservation by providers "is subject to mutual agreement" and the powers "seem too limited". [https://www.coe.int/en/web/octopus/-/ireland]
  - The Criminal Justice (Protection, Preservation of and Access to Data on Information Systems) Bill was approved as a General Scheme in February 2024. Head 5 is preservation, and jurisdiction depends on who controls the data, not where it sits. [https://www.oireachtas.ie/en/debates/debate/joint_committee_on_justice/2024-03-05/2/]
  - Cabinet approved publication in June 2026. [Irish Examiner, secondary: https://www.irishexaminer.com/news/arid-41863539.html] I found no evidence it has been enacted. [unverified]

### 5. Cooperation

- **Budapest Convention:** signed 28/02/2002, **not ratified**. [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185] The Minister said in 2025 that ratification is pending the data bill and an interception law review. [https://www.oireachtas.ie/en/debates/question/2025-05-08/372/]
- **Second Additional Protocol (CETS 224):** not signed. [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224]
- **EU e-Evidence Regulation 2023/1543:** Ireland **opted in** (Recital 100, Protocol 21). [https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R1543]
  - Implemented by the Criminal Justice (International Cooperation on Electronic Evidence and Other Matters) Act 2026. It created the Office of the Director of Criminal Justice International Co-operation as central and enforcing authority. [secondary: https://www.irishlegal.com/articles/bird-bird-irelands-new-law-to-implement-the-eu-e-evidence-package-comes-into-force-tomorrow]
- **European Investigation Order (EIO):** **not applied**. EIOs are held until withdrawn. [https://www.gov.ie/en/department-of-justice-home-affairs-and-migration/policy-information/mutual-legal-assistance/]
- **MLA with Germany:** runs on the 1959 Convention and the 2000 EU MLA Convention, via the Criminal Justice (Mutual Assistance) Act 2008. Central authority: Minister for Justice, MAREQUESTS@JUSTICE.IE, requests in English or Irish. [https://www.irishstatutebook.ie/eli/2008/act/7/section/2/enacted/en/html] [https://www.ejn-crimjust.europa.eu/ejn2021/ContentDetail/EN/5/15] I found no separate bilateral Ireland–Germany MLA treaty. [unverified]
- **24/7 contact:** the Garda National Cyber Crime Bureau (GNCCB) runs a 24/7 service, but the CoE describes it as internal, "to members of An Garda Síochána". [https://www.coe.int/en/web/octopus/-/ireland] Ireland's notified Art. 13 contact point under Directive 2013/40 was not confirmed. [unverified]

### 6. Evidence of practice

- **LabHost / Operation Stargrew (April 2024):** a phishing-as-a-service takedown coordinated by Europol. GNECB-led searches ran in Dublin, Kildare and Waterford, with 2 arrests; about 116 users were linked to Ireland. The Irish targets were domestic suspects, not hosted infrastructure. [https://www.rte.ie/news/2024/0418/1444248-phishing-arrests/] [https://www.thejournal.ie/two-arrested-gardai-global-operation-labhost-phishing-6357692-Apr2024/] (secondary; the Garda release was not retrieved)
- **2021:** Garda-led seizure of Conti domains after the attack on the HSE (Ireland's health service), with servers "in various countries". [https://www.rte.ie/news/ireland/2021/0905/1244805-cyber-attack-gardai/]
- **2025:** Garda took part in the Blacksuit ransomware takedown led by US Homeland Security Investigations (HSI). [https://www.garda.ie/en/about-us/our-departments/office-of-corporate-communications/press-releases/2025/august/an-garda-siochana-collaborates-in-a-successful-international-cybercrime-takedown.html]
- **No case found** of Garda acting on a foreign private tip about phishing hosted in Ireland.

### 7. Verdict

- **Direct report:** the chance that a direct report from phishing.support opens a Garda case is **very low**. Intake is station-based and centred on victims, with no foreign or online fraud channel. The Garda has discretion and limited resources. Data of Irish-registered US providers (Google, Microsoft, Meta, AWS) is often controlled in the US, and there is no general preservation order yet.
- **What Ireland does offer:** substantive jurisdiction is good (2001 Act s.9, 2017 Act s.10).
- **Better route:** a Bavarian prosecutor (or ZCB) issues a **European Production Order (EPOC)** under Regulation 2023/1543 directly to the provider's EU addressee. Ireland opted in, and the Commission lists it as legally and technically ready to receive EPOCs and EPOC-PRs. Use it to get subscriber and IP data within 10 days (8 hours in emergencies). Germany is listed as ready to issue EPOCs only, not EPOC-PRs ([Commission readiness list, 6 Nov 2026](https://commission.europa.eu/document/download/5b3c2ee0-4055-4694-82c3-dc265cd6f108_en?filename=Information%20on%20Member%20States%20ready%20to%20issue%20and%20or%20receive%20EPOCs%20and%20EPOCS-PR.pdf)). Preservation therefore has to run as a voluntary request or straight to production.
- **Backup routes:**
  - An MLA letter of request under the 2000 Convention; an EIO will not work.
  - Spontaneous information under Art. 7 of the 2000 Convention from German authorities to the Garda via Europol (SIENA) if an Irish suspect or link appears. Budapest Art. 26 is unavailable because Ireland has not ratified.
- **For phishing.support itself:** limit outreach to takedown and abuse reports (and certreport@ncsc.gov.ie only if national impact).


---

## Singapore

### 1. Jurisdiction

- **Computer Misuse Act 1993 (CMA), s.13 "Territorial scope of offences under this Act".** Note that in the 2020 Revised Edition this is s.13; s.11 now deals with protected computers. Under s.13(1) the Act applies "in relation to any person, whatever the person's nationality or citizenship, outside as well as within Singapore". Under s.13(3) the Act applies if (a) the accused was in Singapore, (b) for offences under ss.3–8 "the computer, program or data was in Singapore at the material time", or (c) the offence causes or risks serious harm in Singapore. [https://lawplayer.com/sg/article/CMA1993/13 ; https://rm.coe.int/octocom-legal-profile-singapore/16809e9277] So a phishing server or hosting account in Singapore is enough for CMA jurisdiction, even if every victim is foreign. Limb (b) is the relevant one; limb (c), "serious harm in Singapore" (s.13(4)), would not apply to German victims. [https://lawplayer.com/sg/act/CMA1993]
  - Wording caveat: the official SSO page could not be fetched. These are LawPlayer copies of the official text, which say the SSO version prevails.
- **CMA substantive offences:**
  - s.3: unauthorised access. Up to 2 years; up to 7 years if damage results.
  - s.4: access with intent to commit an offence involving fraud or dishonesty. Up to 10 years. [https://lawplayer.com/sg/act/CMA1993]
  - s.10: obtaining, making or supplying devices, programs or passwords for use in ss.3–7 offences. This covers phishing kits and harvested credentials. Up to 3 years, or 5 years for a repeat offence. [https://lawplayer.com/sg/article/CMA1993/10]
  - ss.8A/8B: offences limited to Singpass credentials. [https://lawplayer.com/sg/act/CMA1993]
- **Penal Code s.4B:** a scheduled offence counts as committed in Singapore when a "relevant act" (a physical element of the offence) occurs wholly or partly in Singapore. Operating the phishing page on a Singapore server is arguably such an act. [https://lawplayer.com/sg/article/PC1871/4B] Cheating (ss.415–420) is in the Schedule according to a secondary source [https://www.legal500.com/guides/chapter/singapore-white-collar-crime/] [unverified on the official schedule]. Section 420 carries up to 10 years [https://www.police.gov.sg/Media-Hub/News/2026/10/20261025_man_to_be_charged_for_cheating_money_laundering_and_unauthorised_access].
- **Money laundering:** CDSA s.51 ("assisting another to retain benefits from criminal conduct") is used in scam cases. [https://www.police.gov.sg/Media-Hub/News/2026/08/20260826_police_and_govtech_intervention_dismantles_singpass_compromise_scheme]
- **OCHA 2023:**
  - Under s.6(1)(b), directions are possible on mere suspicion of a scam or malicious cyber activity offence.
  - Under s.6(2), directions can go to providers outside Singapore.
  - However, disabling and account-restriction directions (ss.8–12) only require blocking access **"by Singapore persons"**. OCHA is therefore of little use for German victims.

  [https://lawplayer.com/sg/act/OCHA2023]

### 2. Intake

- **Case-opening channel (police report):** SPF e-Services "non-urgent online report" [https://eservices.police.gov.sg/homepage]. Since 8 Sept 2025, SPF e-services require Singpass or Corppass. The only foreigner exceptions are FIN access for the Certificate of Clearance and the foreign vehicle number for traffic fines. [https://www.police.gov.sg/Media-Hub/News/2025/09/20250907_change_in_methods_to_access_spf_eservices]
  - In practice, a foreign reporter abroad cannot lodge an online report. The only alternatives are in person at a Singapore police station, or the SPF Feedback Portal or hotline (1800-358 0000).
  - After an online report, the reporter receives a report number and the officer in charge [secondary: https://issuu.com/pap.sg/docs/pap_ww_iwd_toolkit_supporting_residents_facing_onl/s/15028511].
  - No victim requirement is stated [unverified].
- **Tip channel (I-Witness):** [https://www.police.gov.sg/i-witness/]
  - Not a police report: "This is not a police report."
  - Reporters can stay anonymous or give contact details.
  - Up to 5 attachments of 1 GB each.
  - "You will not be updated on the outcome."
  - No Singpass or residency restriction is stated on the info page. The form itself (eservices4.police.gov.sg/iwitness/) was not checked [unverified].
  - Language: English [unverified].
  - This is the only realistic police intake for phishing.support. It produces no case number.
- **CERT / takedown (not case-opening):** SingCERT "can only take reports on incidents based in Singapore". If both the affected party and the source are outside Singapore, reporters should go to another CERT. A Singapore-hosted phishing site arguably qualifies because the source is in Singapore. SingCERT points crime reports to the police. [https://www.csa.gov.sg/resources/singcert/cyber-aid/] Email: singcert@csa.gov.sg [https://www.police.gov.sg/Media-Hub/News/2025/10/20251016_police_advisory_on_phishing_scams_involving_cryptocurrency_platforms].
- **Registrar abuse:** the abuse desks of Gname and other registrars are contractual (ICANN) channels, not law enforcement.

### 3. Legality vs opportunity

- **CPC s.17(1):** an officer who suspects an arrestable offence "must" investigate as soon as practicable. [https://lawplayer.com/sg/article/CPC2010/17]
- **CPC s.17(2):** the officer need not investigate if the case "is not of a serious nature", and must not proceed if grounds are insufficient. Reasons must be recorded (s.17(3)).
- The result is a formal duty with a broad, built-in discretion.
- No published loss threshold or foreign-victim policy was found. SPF communications focus on scams against Singapore residents (OCHA's "Singapore persons" design; the press releases below) [inference].

### 4. Domestic powers

- **Production orders, CPC s.20:** a written order from a police officer of sergeant rank or above, with **no court warrant**. It covers any document, thing or data "necessary or desirable for any investigation". It can go to anyone who can access the data from a computer, and covers copies of electronic records. Non-compliance is an offence. [https://lawplayer.com/sg/article/CPC2010/20] In practice it reaches a local host's subscriber data, payment records, logs and content.
- **Computer access, CPC s.39:** includes computers outside Singapore under s.39(2B). **Decryption, CPC s.40.** [https://rm.coe.int/octocom-legal-profile-singapore/16809e9277]
- **Speed:** it is an administrative order, so it is fast. No statutory deadline was found [unverified].
- **Preservation and retention:**
  - No dedicated expedited-preservation order exists. The CoE legal profile lists no Singapore provision against Budapest Arts. 16/17. [https://rm.coe.int/octocom-legal-profile-singapore/16809e9277]
  - No general data-retention law was found. A 12-month telco licence retention figure appears only in secondary sources [unverified].
  - PDPA retention limitation pushes towards deletion. [https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/the-retention-limitation-obligation---ch-18-(270717).pdf]

### 5. Cooperation

- **Budapest Convention:** Singapore is **not** a party, signatory or invited state (CoE chart, status 17/11/2026). It therefore has no Second Additional Protocol, no Budapest Art. 26 and no Budapest 24/7 point. [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185]
- **UN Cybercrime Convention (Hanoi, Oct 2025):** Singapore reportedly did not sign [secondary: https://www.justsecurity.org/124057/promise-peril-cybercrime-convention/; unverified].
- **UNTOC:** ratified 28/08/2007, with the AG as central authority. [https://www.unodc.org/unodc/en/treaties/CTOC/countrylist_fix.html] UNTOC Art. 18(4) allows spontaneous information. Germany is also a party [unverified here].
- **EU e-Evidence:** not applicable, since Singapore is a third country.
- **MLA with Germany:** no MLA treaty was found, and Germany is not shown as a "prescribed foreign country". Assistance is possible under MACMA if Germany gives a **reciprocity undertaking under s.16(2)**. The central authority is the AGC Crime Division (AGC_CentralAuthority@agc.gov.sg). [https://www.agc.gov.sg/our-roles/public-prosecutor/mutual-legal-assistance/]
- **Europol:** Working Arrangement with Singapore, in force 29 Nov 2024. [https://www.europol.europa.eu/partners-collaboration/agreements/singapore] SIENA or liaison implementing agreements are not confirmed [https://eucrim.eu/news/europol-signs-working-arrangement-with-singapore/].
- **INTERPOL:** member.

### 6. Evidence of practice

- **Operation Secure (INTERPOL, Jan–Apr 2025):** SPF Cybercrime Command and CSA took down more than 1,000 Singapore-based malicious IPs. This was driven by foreign and INTERPOL intelligence, not a private report. No arrests were mentioned. [https://www.police.gov.sg/media-hub/news/2025/06/20250611_more_than_1000_malicious_ip_addresses_in_singapore_taken_down_in_joint_operation]
- **Tycoon2FA (2026):** SPF Cyber Command shared infrastructure intelligence with Pakistan's NCCIA and INTERPOL after a Europol-supported disruption, leading to 2 arrests in Pakistan. The trigger was cases reported in Singapore. [https://www.police.gov.sg/Media-Hub/News/2026/08/20260803_foreign_cybercrime_syndicate_arrested_in_pakistan_following_international_collaboration]
- **911 S5 botnet (2024):** the administrator was arrested in Singapore and search warrants were executed there at the FBI's request [secondary: https://www.scmp.com/news/world/united-states-canada/article/3264631/chinese-national-wang-yunhe-arrested-running-likely-worlds-largest-cybercrime-botnet].
- **No case was found** where SPF opened an investigation on a foreign private reporter's tip about Singapore-hosted phishing aimed at foreign victims.

### 7. Verdict

A direct report from phishing.support has a **low chance** of opening a case:

- The formal police report needs Singpass or physical presence.
- I-Witness takes tips but gives no case number and no feedback.
- s.17(2) CPC lets SPF drop "not serious" cases.
- OCHA protects only Singapore persons.

Jurisdiction (CMA s.13(3)(b)) and powers (warrantless s.20 production orders) are strong. That makes a request from an authority effective.

**Better route:**

1. ZCB/LKA Bayern or the prosecutor's office opens the German case.
2. BKA passes the information to SPF Cyber Command via INTERPOL or Europol (Working Arrangement), as spontaneous information. UNTOC Art. 18(4) is the treaty basis; Budapest Art. 26 is not available.
3. A formal MACMA request with a s.16(2) reciprocity undertaking follows for evidence.

In parallel, phishing.support can file an I-Witness tip with attachments, send a SingCERT report for takedown, and file Gname registrar abuse reports.


---

## Turkey (Türkiye)

### 1. Jurisdiction

- **Territorial scope.** Under TCK 5237 Art. 8(1), Turkish law applies to offences committed in Turkey. An offence counts as committed in Turkey if the act happens *wholly or partly* there, or if its result occurs there: "Fiilin kısmen veya tamamen Türkiye'de işlenmesi veya neticenin Türkiye'de gerçekleşmesi halinde suç, Türkiye'de işlenmiş sayılır" [https://www.mevzuat.gov.tr/MevzuatMetin/1.5.5237.pdf]. Running a phishing kit on a server in Turkey should therefore count as partly acting in Turkey, even if every victim is abroad. The statute does not name servers explicitly, so this is my reading [unverified: no case law found on servers specifically].
- **Venue.** CMK Art. 12(1) gives jurisdiction to the court of the place of the offence. Art. 12(6) adds the victim's residence for offences committed with IT systems or banks, which does not help when the victims are in Germany [https://www.mevzuat.gov.tr/MevzuatMetin/1.5.5271.pdf].
- **Budapest reservation.** Turkey's Art. 22 reservation concerns only nationality jurisdiction (TCK Arts. 11 and 13), not territoriality [https://www.coe.int/en/web/conventions/full-list?module=declarations-by-treaty&numSte=185&codeNature=0&codePays=TUR].
- **Offences that fit phishing** (all in TCK 5237, same URL):
  - Art. 243: unlawfully entering or staying in an IT system (illegal access).
  - Art. 244(2): altering, deleting or transferring data. Art. 244(4): doing so to gain an unjust benefit carries 2–6 years.
  - Art. 245: misuse of bank or credit cards.
  - Art. 245/A: making, selling, possessing etc. devices, programs, passwords or security codes made for these offences. This covers phishing kits and credential lists.
  - Art. 158(1)(f): aggravated fraud "Bilişim sistemlerinin, banka veya kredi kurumlarının araç olarak kullanılması suretiyle".
  - Art. 136: unlawfully obtaining or disseminating personal data.
  - Art. 282: money laundering.

### 2. Intake

**Channels that open a case:**

- **Prosecutor or police complaint (CMK Art. 158).** A report (ihbar) can go to a Chief Public Prosecutor's Office or to the police, in writing or orally for the record. Reporting to the governor or a court also reaches the prosecutor. Art. 158(3) allows reports to Turkish embassies and consulates for crimes committed abroad that must be prosecuted in Turkey [https://www.mevzuat.gov.tr/MevzuatMetin/1.5.5271.pdf]. The law does not require the reporter to be a victim or a Turkish national.
- **Where to send it.** The competent office is the one for the server's location, e.g. the Istanbul Chief Public Prosecutor's Office. A written petition can be posted or handed in.
- **Language.** The CMK says nothing on the language of a report. In practice expect Turkish [unverified].
- **Online filing.** UYAP Vatandaş (via e-Devlet) accepts petitions only from users with a Turkish ID and e-signature [https://uyap.gov.tr/Genel-Bilgi] [https://vatandas.uyap.gov.tr/main/vatandas.jsp]. It is unusable for a foreigner without a Turkish ID.
- **Feedback.** If the prosecutor dismisses a report under Art. 158(6), the decision must be notified "ihbarda bulunana", i.e. also to the informant, and it can be appealed under Art. 173 [CMK URL above]. That is the only statutory feedback right a non-victim has.
- **EGM Cybercrime Department** (Siber Suçlarla Mücadele Daire Başkanlığı, the national police). It has an online report module at https://onlineislemler.egm.gov.tr/Sayfalar/Ihbar.aspx and the email siber@egm.gov.tr [unverified: I could not open the form or confirm the address on an official page]. I could not confirm the identity requirements, whether attachments are possible, or whether a case number is given.

**Takedown/CERT channel only:**

- **Siber Güvenlik Başkanlığı** (the Cyber Security Presidency; the successor framework of USOM/TR-CERT) runs a form at https://siberguvenlik.gov.tr/ihbar and the address ihbar@siberguvenlik.gov.tr. "Oltalama" (phishing) is one of its categories [https://siberguvenlik.gov.tr/ihbar].
  - Required fields: email, title and message. There is no Turkish ID field, no upload field, and the page is Turkish only.
  - The page says nothing about investigation or feedback. Secondary sources say a confirmed site is added to the malicious-link list and blocked from Turkey [unverified].
  - Law 7590 (24/7/2026) moved the Law 5651 powers of the President of BTK (the telecoms regulator) to the President of this body [https://www.mevzuat.gov.tr/MevzuatMetin/1.5.5651.pdf, footnotes to Art. 2].

### 3. Legality vs opportunity principle

- **Duty to investigate.** CMK Art. 160(1): as soon as the prosecutor learns, "ihbar veya başka bir suretle", of facts suggesting an offence, he must "hemen işin gerçeğini araştırmaya başlar". Art. 170(2) requires an indictment if there is sufficient suspicion [CMK URL]. This is the legality principle.
- **Filters.** Art. 158(6) allows a no-investigation decision without any inquiry when the act is clearly not an offence or the report is "soyut ve genel" (abstract and general). Art. 172 allows dismissal (no prosecution) for lack of evidence or impossibility of prosecution [CMK URL]. A report that names no suspect, only a URL, a hosting account and German victims, risks a quick 158(6) or 172 decision.
- **Thresholds.** I found no published minimum-loss threshold or policy statement on cybercrime with foreign victims [none found].

### 4. Domestic powers

- **Retention.** Law 5651 Art. 5(3): hosting providers (yer sağlayıcı) must keep traffic data for 1–2 years, the exact period set by regulation [https://www.mevzuat.gov.tr/MevzuatMetin/1.5.5651.pdf]. Art. 2(1)(j) defines traffic data as IP addresses, source and destination ports, start and end times of the service, service type, data volume "ve varsa abone kimlik bilgileri" (subscriber identity, if available) [same]. The current regulation's exact period is [unverified]; the 2007 regulation said 6 months.
- **Information orders.** CMK Art. 332: written requests from a prosecutor or judge must be answered within 10 days. Art. 161 lets the prosecutor carry out "her türlü araştırma" (any inquiry) [CMK URL]. That is the likely route to subscriber and payment data [unverified in practice].
- **Server content.** CMK Art. 134: search, copying and seizure of computers and files used by the suspect. It needs a judge's order; in urgent cases the prosecutor can order it, with judicial approval within 24 h [CMK URL]. The Constitutional Court annulled Art. 134 on 12/2/2026 (E.2023/128, K.2026/36), effective 25/2/2027 [CMK URL, footnote 32]. Expect new rules.
- **Communications.** Interception and signal data fall under Art. 135 and need a judge's order [CMK URL].
- **Preservation.** I found no separate expedited-preservation provision in the CMK; Turkey relies on the 5651 retention duty [unverified]. Turkey reserves the right to refuse Budapest Art. 29 preservation requests without dual criminality [CoE declarations URL]. Phishing meets that test anyway.
- **Speed.** [unverified]

### 5. Cooperation

- **Budapest Convention:** signed 10/11/2010, ratified 29/09/2014, in force 01/01/2015 [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185].
- **Second Additional Protocol (CETS 224):** not signed by Turkey. Germany has signed only (27/01/2023) [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224].
- **24/7 contact point:** Turkish National Police, Department of Cybercrime, Ankara. Central authority for mutual legal assistance: Ministry of Justice [CoE declarations URL].
- **EU e-Evidence Regulation 2023/1543:** does not apply to Turkish authorities. It reaches a Turkish hoster only if it offers services in the Union [EUR-Lex; my inference].
- **Germany–Turkey legal basis:**
  - European Convention on Mutual Assistance in Criminal Matters 1959 (ECMA): in force for Turkey 22/09/1969, for Germany 01/01/1977 [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=030].
  - Its Second Additional Protocol (ETS 182; Art. 11 covers spontaneous information): Turkey from 01/11/2016, Germany from 01/06/2015 [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=182].
  - Bilateral police agreement of 3/3/2003 on serious crime (BGBl. 2004 II S. 1059) [https://www.gesetze-bayern.de/Content/Document/RiVASt-ANL_2?view=Print].
  - Turkish domestic law: Law 6706 on international judicial cooperation in criminal matters. Arts. 23–25 cover transfer of investigations in both directions [https://www.mevzuat.gov.tr/MevzuatMetin/1.5.6706.pdf].
- **Europol:** strategic agreement only (2004), no exchange of personal data [https://www.europol.europa.eu/cms/sites/default/files/documents/agreement_on_cooperation_between_the_european_police_office_and_the_republic_of_turkey.pdf]. I found no concluded Eurojust agreement with Turkey [unverified].

### 6. Evidence of real practice

- **July 2026:** the Istanbul Chief Public Prosecutor's Office opened an investigation into a Maslak call centre targeting Czech and other European victims. It started "Çekya adli makamlarının uluslararası adli yardımlaşma çerçevesinde ilettiği bilgi ve belgeler üzerine" (on information sent by Czech judicial authorities through mutual legal assistance) [https://www.son.tv/istanbul-cumhuriyet-bassavciligindan-uluslararasi-dolandiricilik-sebekesine-operasyon/] (press, not primary).
- **September 2026:** an Istanbul/Muğla operation against investment-fraud call centres with only foreign victims. Hundreds of victim complaints obtained via Interpol were reportedly used, and roughly 175–201 people were detained (figures differ by outlet) [https://www.sozcu.com.tr/son-dakika-istanbul-da-plazalara-dev-operasyon-p359394] (press).
- Both cases started from foreign authorities, not private tips.
- I found no case where Turkish police acted on a foreign private-sector tip about phishing hosted in Turkey [none found].

### 7. Verdict

Legally the case is strong. Art. 8 territoriality covers the server, the offences are well defined, the prosecutor must investigate, and there are 1–2-year retention duties.

In practice, a direct report from phishing.support has a low chance of opening a real investigation:

- It would be written in a foreign language, from a non-victim, by post or email.
- There would be no Turkish victim and no named suspect, which invites an Art. 158(6) "abstract/general" dismissal.
- The online channels effectively need a Turkish ID, and the form channel only leads to takedown or blocking.

The better route has four parts:

1. **German complaint.** File it with the Bavarian authorities (ZCB Bamberg / LKA).
2. **Fast preservation.** Ask for preservation at Corelux through the BKA → Turkish 24/7 contact point (Budapest Art. 29/35).
3. **Spontaneous information or transfer.** Ask the German prosecutor to send spontaneous information (Budapest Art. 26; ETS 182 Art. 11), or a request to take over the investigation. Under Law 6706 these go via the Ministry of Justice to the competent Turkish prosecutor's office, which is the pattern the Czech case followed.
4. **Takedown in parallel.** Report the site to siberguvenlik.gov.tr. Optionally, also send a short Turkish-language ihbar to the prosecutor's office where the server is located, citing the German file number.


---

## China

### 1. Jurisdiction

- **Ubiquity rule.** PRC Criminal Law art. 6(3): "犯罪的行为或者结果有一项发生在中华人民共和国领域内的，就认为是在中华人民共和国领域内犯罪." An offence counts as committed in China if either the act or its result happens on PRC territory. Nothing in the article requires the victim to be Chinese. [http://www.npc.gov.cn/npc/c1773/c1848/c21114/c25714/c25716/201905/t20190522_46193.html]
- **Server location is a place of crime.** The SPC/SPP/MPS Opinion on criminal procedure in information-network cases, 法发〔2022〕23号, art. 2(2), lists "the location of the server used by the network service used to commit the crime" and "the location of the network service provider" as places of crime. The police of that place file the case. [https://www.spp.gov.cn/spp/xwfbh/wsfbt/202208/t20220830_575301.shtml; https://www.mps.gov.cn/n2253534/n2253535/c8676320/content.html] I saw this only in summaries and did not read the full text. [unverified wording]
- **Substantive offences** (consolidated text up to Amendment XII, 2023) [https://fgk.chinatax.gov.cn/zcfgk/c100009/c5212248/content.html]:
  - **Art. 285(2):** illegally obtaining data from a computer system, "情节严重". **Art. 285(3):** providing programs or tools for intrusion. This could cover phishing-kit sellers. [legal reading unverified]
  - **Art. 287-1(1):** setting up a website "用于实施诈骗" (for committing fraud). This fits a phishing site directly.
  - **Art. 287-2 (帮信罪):** knowingly providing "服务器托管、网络存储" (server hosting, network storage) or payment help to online crime.
  - **Art. 253-1:** selling or providing citizens' personal information.
  - **Art. 266:** fraud. **Art. 191:** money laundering, limited to seven predicate categories, including financial fraud. Laundering proceeds of ordinary fraud falls under art. 312. [art. 312 unverified]
- **Anti-Telecom and Online Fraud Law (2022) art. 3** covers fraud "在中华人民共和国境内实施" (committed inside China) and help given from abroad "针对境内" (aimed at China). Its policy focus is on Chinese victims. [https://www.mps.gov.cn/n6557558/c8681178/content.html]
- **Caveat on the named providers:**
  - Alibaba Cloud's international site contracts through Alibaba Cloud (Singapore) Private Limited, or through EU and US entities for customers there. [https://www.alibabacloud.com/help/faq-detail/42427.htm] Phishing on Alibaba Cloud International is often not "Chinese infrastructure" in law.
  - Eranet International Limited (IANA registrar ID 1868) is a Hong Kong company, so Hong Kong law applies, not PRC law. [https://www.iana.org/assignments/registrar-ids/registrar-ids.xhtml; https://www.hkirc.hk/en/our-services-support/domain-services/list-of-registrars/]

### 2. Intake

**Case-opening channels:**

- **Statutory right to report.** Criminal Procedure Law (CPL, 2018) art. 110: "任何单位和个人" (any unit or individual) may report to the public security organs (公安), the procuratorate (检察院) or the courts. Victim status is not required, and foreigners are not excluded. [https://zbjc.mof.gov.cn/zhengcefabu/202106/t20210608_3716216.htm] In practice a report is made at the local public security bureau (公安局) where the server sits, in Chinese.
- **MPS 网络违法犯罪举报网站 (cyberpolice.cn).** Chinese only. You can report with or without registration and get a query account for tracking. Real-name reports are encouraged, with contact details. [https://baike.baidu.com/item/%E7%BD%91%E7%BB%9C%E8%BF%9D%E6%B3%95%E7%8A%AF%E7%BD%AA%E4%B8%BE%E6%8A%A5%E7%BD%91%E7%AB%99/62655027] I could not access the site itself, so the following are [unverified]: whether a foreign reporter without a Chinese phone number or ID can register, and whether attachments are possible. A tip there is a lead (线索), not a formal complaint (控告) with a duty to notify the reporter.

**Takedown and CERT channels (no case opening):**

- **CNCERT/CC**, contact cncert_report@cert.org.cn, works in English. Its weekly reports describe cross-border phishing handled with registrars and foreign CERTs. [https://www.cert.org.cn/publish/english/upload/File/Weekly%20Report%20of%20CNCERT-Issue%205%202026%20EN.pdf]
- **China Anti-Phishing Alliance (APAC, secretariat at CNNIC).** It stops DNS resolution for .cn and non-.cn phishing domains. The contacts jubao@apac.cn and jubao.apac.cn date from 2011. [http://www.gov.cn/govweb/fwxx/kp/2011-04/21/content_1849332.htm] [current status unverified]
- **12321.cn** handles spam and junk information. [https://www.12321.cn/information]
- **Provider abuse desks:** the Alibaba Cloud and Eranet abuse teams.

### 3. Legality vs opportunity

- **Duty to file, with a threshold.** CPL art. 112: police "应当立案" (shall file a case) when they believe there are criminal facts that require criminal liability. Otherwise they do not file and must tell the complainant (控告人) why. [https://zbjc.mof.gov.cn/zhengcefabu/202106/t20210608_3716216.htm] This is formally a legality principle, but the filing threshold is substantive.
- **"情节严重" thresholds.** Most cyber offences need "serious circumstances". For telecom/online fraud, "数额较大" (relatively large amount) starts at RMB 3,000. [法发〔2016〕32号: https://www.spp.gov.cn/xwfbh/wsfbt/201612/t20161220_176259_1.shtml]
- **Proof problem for foreign victims.** A Chinese police officer would have to establish the German victims' losses, which needs foreign evidence. I found no published policy on prioritising cases with only foreign victims. [unverified] Public policy statements centre on protecting Chinese citizens (ATOFL art. 3).

### 4. Domestic powers

- **Compelled production.** CPL art. 54: police "有权向有关单位和个人收集、调取证据", and those asked "应当如实提供" (must provide truthfully). [https://www.xinhuanet.com/politics/2018-10/27/c_1123620821_5.htm]
- **Self-issued notice, no court.** The MPS Electronic Data Rules (公通字〔2018〕41号) art. 41: a 调取证据通知书 (evidence-collection notice) approved by the head of the handling department. No court order is involved. [http://gdga.gd.gov.cn/xxgk/flfg/content/post_2510956.html]
- **What it covers.** Real-name subscriber data, payment records, logs and content are all within reach. Real-name registration is legally required (Cybersecurity Law; ATOFL). [unverified article numbers]
- **Preservation.** Same Rules, art. 39: "冻结电子数据" (freezing electronic data) for 6 months, renewable. [same URL] A draft revision was published in 2026. [https://www.secrss.com/articles/90623]
- **Retention and assistance duties** (Cybersecurity Law as amended on 2025-10-28, in force 2026-01-01):
  - art. 23(3): network logs kept for at least 6 months.
  - art. 30: operators must give technical support and assistance to public security organs. [https://www.cac.gov.cn/2025-12/29/c_1768735112911946.htm]

### 5. Cooperation

- **Budapest Convention:** China is not a party and does not appear on the chart. Germany has been a party since 2009-07-01. [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185] So there is no Second Additional Protocol and no Budapest 24/7 network link. Contact runs through Interpol NCBs. [unverified]
- **UN Cybercrime Convention (Hanoi):** China signed in October 2025. [https://www.justsecurity.org/124057/promise-peril-cybercrime-convention/] Germany did not sign in Hanoi; the cabinet approved signature on 2026-04-15 [https://www.jura.uni-saarland.de/bundeskabinett-billigt-un-cybercrime-konvention/], and the UN Treaty Collection lists Germany's signature on 1 Jun 2026 (per [cross-border-investigation-instruments.md](cross-border-investigation-instruments.md)). The convention is not in force.
- **No China–Germany criminal MLA treaty.** Talks have run since 2007, and four rounds were reported by 2014. [https://www.mfa.gov.cn/web/gjhdq_676201/gj_676203/oz_678770/1206_679086/xgxw_679092/201410/t20141012_9334555.shtml] Requests therefore go by reciprocity assurance through diplomatic channels under the International Criminal Judicial Assistance Law arts. 5 and 13. UNTOC art. 18 is another possible basis. [https://subsites.chinadaily.com.cn/npc/2018-10/26/c_791384.htm; UNTOC basis unverified]
- **Blocking statutes.**
  - ICJAL art. 4: no evidence may go to a foreign state without approval. [same URL]
  - Data Security Law art. 36: data stored in China may not go to foreign judicial or law-enforcement authorities without approval. [https://www.cac.gov.cn/2021-06/11/c_1624994566919140.htm]
- **Hong Kong:** the Germany–Hong Kong MLA agreement was suspended in 2020. [https://www.doj.gov.hk/en/external/table3ti.html]
- **EU e-Evidence:** it does not apply to China itself. It can reach Alibaba's EU-facing entities, Alibaba.com (Europe) Ltd and Alibaba (Netherlands) B.V., if Alibaba offers services in the Union. [https://www.alibabacloud.com/help/en/legal/latest/alibaba-cloud-international-website-product-terms-of-service-v-3-8-0; applicability unverified] A conflict with DSL art. 36 would trigger the Regulation's conflict-of-law review.

### 6. Evidence of real practice

- **Beijing 2019:** the Beijing PSB cyber-security unit broke up a gang building phishing sites for fraudsters at home and abroad, charged under art. 287-1. The victims were Chinese. [https://www.secrss.com/articles/8812 (secondary)]
- **China–Korea 2026:** a joint investigation by Gangwon police and the Jilin Public Security Department arrested voice-phishing operators in China. This was state-to-state cooperation, not a private tip. [https://www.koreatimes.co.kr/amp/southkorea/law-crime/20260825/police-bust-china-based-phishing-ring-with-local-police (secondary)]
- **Interpol First Light 2024** included the MPS. [https://en.wikipedia.org/wiki/Operation_First_Light_2024 (secondary)]
- I found no case where Chinese police acted on a foreign private tip about phishing hosted in China against foreign victims.

### 7. Verdict

**Chance of a case: close to zero.**

- **Legal hooks exist.** Under art. 6, a server or hosting account in China puts the offence within PRC jurisdiction. Arts. 287-1 and 287-2 fit phishing sites and their hosting, and police could compel the data quickly without a court.
- **Practical barriers block it.** Intake is Chinese-language and built for residents. Victims, losses and evidence sit in Germany. "情节严重" has to be proven. Policy focuses on Chinese victims. The results could not reach Germany anyway because of DSL art. 36 and ICJAL art. 4.
- **Better routes:**
  - For **takedown and DNS suspension**, use CNCERT, APAC/CNNIC and the provider's abuse desk. These are fast but give no evidence.
  - For **Alibaba Cloud International**, check the contracting entity first. If it is an EU entity, have the Bavarian ZCB/StA issue an EU e-Evidence production order.
  - For **Eranet**, treat it as a Hong Kong matter.
  - For **genuinely mainland infrastructure**, the Bavarian prosecutor should pass information spontaneously via BKA→Interpol NCB Beijing. A formal reciprocity-based MLA request is reserved for large campaigns.


---

## Russia

### 1. Jurisdiction

- **Territorial scope.** Art. 11(1) of the Russian Criminal Code (УК РФ): "Лицо, совершившее преступление на территории Российской Федерации, подлежит уголовной ответственности по настоящему Кодексу" (a person who commits a crime on Russian territory is liable under this Code) [https://www.consultant.ru/document/cons_doc_LAW_10699/d8be5c1d1e38cae956538d0b81e8d40d9fa520d8/]. The Code has no explicit ubiquity clause. Russian doctrine and practice treat an act carried out through computing resources in Russia as committed in Russia, and the victims' nationality does not matter [unverified: no primary commentary found].
- **Substantive offences:**
  - Art. 159.6 (computer fraud): theft "путем ввода, удаления, блокирования, модификации компьютерной информации" (by entering, deleting, blocking or modifying computer data) [https://www.consultant.ru/document/cons_doc_LAW_10699/51c53d82b60ac8c009745bdea3838d507064c6d3/].
  - Art. 272 (unlawful access to protected computer information that leads to its destruction, blocking, modification or copying) [https://www.consultant.ru/document/cons_doc_LAW_10699/5c337673c261a026c476d578035ce68a0ae86da0/].
  - Art. 272.1 (unlawful collection or storage of computer data containing personal data, and running resources for that purpose). This is the closest fit for a credential-harvesting panel [https://www.consultant.ru/document/cons_doc_LAW_10699/deefead19003ba8266e85fbf42fc31f60ed3c698/].
  - Art. 273 (creating, using or distributing malicious programs). Whether a phishing kit counts is [unverified] [https://www.consultant.ru/document/cons_doc_LAW_10699/a4d58c1af8677d94b4fc8987c71b131f10476a76/].
  - Art. 187 (unlawful trade in means of payment) [https://www.consultant.ru/document/cons_doc_LAW_10699/539a9a6196eae24f91d30781eced78e28b508617/].
  - Arts. 174 and 174.1 (money laundering) [https://www.consultant.ru/document/cons_doc_LAW_10699/4dfcfc8807c829f92212ce92efe818c4a707a3ca/].
- **Phishing kits.** No offence specifically covers possessing a phishing kit.

### 2. Intake

- **Case-opening channel: police (МВД) or the Investigative Committee.**
  - A crime report (заявление о преступлении) can be oral or written (Art. 141(1) of the Criminal Procedure Code, УПК РФ). A written report must be signed (Art. 141(2)). The reporter is warned of liability for knowingly false denunciation under Art. 306 (Art. 141(6)). An anonymous report cannot be grounds to open a case (Art. 141(7)) [https://www.consultant.ru/document/cons_doc_LAW_34481/a0cbfcf18594be9e27992cdb9a5aa9e641032b62/].
  - The law on citizens' appeals (59-FZ, Art. 1(3)) also covers appeals from foreign citizens, and Art. 1(4) covers legal entities [https://www.consultant.ru/document/cons_doc_LAW_59999/8bf514cf02b2bc03abb361625d55d47a4a534317/]. A foreign reporter can therefore use the МВД online form (мвд.рф → «Приём обращений»).
  - Language: Russian. File limits are about 5 MB per file. Whether an address abroad is accepted is [unverified]; the page was blocked for fetching.
  - A victim is not legally required: any person's report triggers the duty to check it (§3).
  - You get a registration number and a written answer, usually within 30 days under 59-FZ [unverified for crime reports].
  - In practice an online "appeal" is usually forwarded to a territorial police unit, which may ask the reporter to appear or give explanations [unverified].
- **Prosecutor's Office (Генпрокуратура).** It supervises but does not run the checks itself; it forwards reports to investigators [https://epp.genproc.gov.ru/ru/web/proc_37/activity/legal-education/explain?item=55049461].
- **Takedown and CERT channels (no case opening):**
  - NCCCI (НКЦКИ, run by the FSB) at incident@cert.gov.ru. Its notification form is aimed at operators of critical infrastructure and owners of Russian resources [https://www.cert.gov.ru/uvedomlenie.php].
  - RU-CERT phishing abuse: asks for the phishing URL, the URL of the legitimate original, and the date/time found [https://www.cert.ru/ru/abuse.shtml].
  - Under 149-FZ Art. 10.2-1, hosting providers must be in the Roskomnadzor registry [https://www.consultant.ru/document/cons_doc_LAW_61798/b99fcec60c7460838ae71cdd49a1bac4332fcb12/]. Abuse mail to the hoster stays the fastest route.
  - I found no public page linking the hoster Mastertel to phishing or bulletproof hosting.

### 3. Legality vs opportunity

- **Legality principle.** Under Art. 144(1) of the Criminal Procedure Code, investigators "обязаны принять, проверить сообщение о любом совершенном или готовящемся преступлении" (must accept and check any report of a committed or planned crime) and decide within 3 days. Under Art. 144(3) this can be extended to 10 days, or 30 days when audits, forensic examinations or operational-search measures are needed [https://www.consultant.ru/document/cons_doc_LAW_34481/a3d0f7ee6816ad8ac5a3a3975cf93b26a443c4f8/].
- **Duty to prosecute.** Art. 21 of the Code (обязанность осуществления уголовного преследования) sets the general duty [https://www.consultant.ru/document/cons_doc_LAW_34481/78b5ba80090569beee206dac703e1e32d21e9a3c/].
- **Practical bar.** Art. 159.6 needs a theft; Art. 272 needs actual destruction, blocking, modification or copying of data. Without a German victim's statement and proof of damage, the likely result is a refusal to open a case for lack of corpus delicti (Art. 145) [unverified as practice].
- **Policy.** I found no published policy on foreign victims.

### 4. Domestic powers

- **Hosting providers.** Under 149-FZ Art. 10.2-1 [https://www.consultant.ru/document/cons_doc_LAW_61798/b99fcec60c7460838ae71cdd49a1bac4332fcb12/]:
  - Part 5: they must identify and/or authenticate clients before providing service. This means subscriber identity exists.
  - Part 3: they must meet technical requirements set for the operational-search and security bodies.
  - Part 4.1: they must connect to the state anti-ICT-fraud information system.
- **"Organisers of information distribution" (ОРИ, e.g. messaging and mail services), 149-FZ Art. 10.1:**
  - Part 3: store metadata and user data for 3 years and content for up to 6 months.
  - Part 3.1: hand it to the operational-search and security bodies "в случаях, установленных федеральными законами" (in cases set by federal law) [https://www.consultant.ru/document/cons_doc_LAW_61798/].
  - Telecom retention under 374-FZ (Yarovaya): 6 months content, 3 years metadata [unverified, secondary: https://wilmap.stanford.edu/entries/federal-law-374-fz-amending-federal-law-combating-terrorism-and-certain-legislative-acts].
- **Instruments:**
  - Requests during the pre-investigation check under Art. 144(1).
  - Connection data: Art. 186.1, with a court order under Art. 165 [https://www.consultant.ru/document/cons_doc_LAW_34481/1246031d9701ba11ab390b5ced7b5e56c14b7b9f/].
  - Seizure: [unverified] that Arts. 182/183 are the ones used.
  - Operational-search inquiries (оперативно-розыскные мероприятия) under the Operational-Search Activities law, 144-FZ [unverified].
  - In practice access is fast because the security services have built-in technical access [unverified].
- **Preservation order.** None found. There is no Budapest-style Art. 16 equivalent; statutory retention fills that role [unverified].

### 5. Cooperation

- **Budapest Convention:** Russia is not a party and has opposed it. The Second Additional Protocol is not applicable [unverified; the Council of Europe chart did not render].
- **UN Convention against Cybercrime:** signed by Prosecutor General Gutsan in Hanoi on 25.10.2025 [https://interfax.com/newsroom/top-stories/114519/]. No ratification confirmed; Germany's status was not checked.
- **EU e-Evidence:** not applicable.
- **European Convention on Mutual Assistance in Criminal Matters (ECMA, 1959):** not among the 21 Council of Europe treaties that Russia's law 43-FZ (28.02.2023) declared terminated [http://www.kremlin.ru/acts/bank/48975].
  - The Russian Ministry of Justice still lists ECMA (in force 09.03.2000), its first Additional Protocol (09.03.2000) and the Second Additional Protocol (01.01.2020) [https://minjust.gov.ru/ru/pages/perechen-mezhdunarodnyh/].
  - Pravo.ru reported in 2023 that Russia planned to leave ECMA as well [https://pravo.ru/story/245128/]. Not confirmed by a primary source.
  - The Council of Europe rule is that Russia remains party to treaties open to non-member states [https://rm.coe.int/0900001680a661ae].
- **Germany–Russia:** no bilateral MLA treaty in the Russian Ministry of Justice list.
  - The German route is the Federal Office of Justice (Bundesamt für Justiz) → Russian Prosecutor General's Office, with a case-by-case ordre-public check [https://dserver.bundestag.de/btd/19/242/1924249.pdf].
  - Russia executes foreign requests under treaties or on reciprocity (Art. 457(1) of the Criminal Procedure Code) [https://www.consultant.ru/document/cons_doc_LAW_34481/978fcc8d14628b074b83f3083ca9b09568d20d3a/].
  - Since 2022 Germany has stopped state cooperation with Russia in general [https://www.auswaertiges-amt.de/de/newsroom/regierungspressekonferenz-2782764]. No police-specific statement found.
- **24/7 contact point:** none under Budapest. Russia was formerly in the G7/G8 24/7 network via the МВД's cybercrime units (Управление «К», now under the Bureau of Special Technical Measures) [unverified].

### 6. Evidence of practice

- **REvil (the main precedent):** in January 2022 the FSB and МВД raided 25 addresses after a request from US authorities [https://tass.ru/proisshestviya/13431243].
  - The October 2024 convictions were only under Art. 187 and Art. 273. There was no charge for the foreign ransomware victims [https://www.kommersant.ru/doc/7263987].
  - This shows Russia acts on foreign information only through state-to-state, political channels, and prosecutes domestic-law angles.
- I found no case where Russian police acted on a private foreign tip about phishing hosted in Russia.
- Russian enforcement against phishing is aimed at Russian victims and banks.

### 7. Verdict

- **Direct report from phishing.support:** realistic chance of opening a case is close to zero.
  - It is formally possible as a signed Russian-language заявление, and the duty to check applies.
  - In practice it would end in a refusal to open a case: no Russian victim, no damage proven in Russia, a foreign reporter, and political conditions after 2022.
  - It also exposes the reporter's identity to Russian security services.
- **Better routes:**
  1. Abuse/takedown to the hoster, RU-CERT and the registrar.
  2. The Bavarian prosecutor (StA/ZCB Bamberg) handles the German case. It can use Europol data on bulletproof-hosting infrastructure. An MLA request to the Russian Prosecutor General's Office under ECMA is possible on paper but slow and unlikely to succeed.
  3. If the Russian hosting is used via US or EU services (Cloudflare, payment providers), use those jurisdictions' preservation and disclosure routes instead.


---

## India

### 1. Jurisdiction

- **The IT Act reaches foreign actors if an Indian computer is involved.** IT Act 2000 s.1(2) applies the Act to "any offence or contravention thereunder committed outside India by any person". s.75(2) applies it to offences committed outside India "if the act or conduct constituting the offence … involves a computer, computer system or computer network located in India" [https://www.indiacode.nic.in/bitstream/123456789/13116/1/it_act_2000_updated.pdf]. A phishing kit on an Indian server, or a domain registered with PDR in Mumbai, fits this wording. Nothing in the provision requires an Indian victim. No case law on this was found [unverified as to court practice].
- **Substantive IT Act offences** (same source):
  - s.43 covers access, download and data extraction without permission. s.66 makes any s.43 act punishable when done "dishonestly or fraudulently".
  - s.66C (identity theft) covers fraudulent use of the "password or any other unique identification feature of any other person", up to 3 years. This fits credential harvesting.
  - s.66D covers cheating by personation "by means of any communication device or computer resource", up to 3 years. This fits brand-impersonating phishing pages.
  - s.77B: offences of 3 years and above are cognizable, and those of exactly 3 years are bailable. s.78: only an officer of Inspector rank or above may investigate.
- **The BNS 2023 is narrower.** s.1(3) covers acts within India. s.1(5)(c) covers persons outside India committing an offence "targeting a computer resource located in India" [https://indiacode.ecourtsindia.com/bns/section/1/, a mirror of India Code]. A server in India used against German banks is used, not targeted, so a foreign operator is covered by the IT Act s.75 rather than the BNS. An operator acting from India is covered territorially either way. BNS s.318(4) (cheating that induces delivery of property) carries up to 7 years and is cognizable [https://indiacode.ecourtsindia.com/bns/section/318/].
- **Phishing kits and money laundering.** No offence specific to possessing phishing kits was found. Whether s.318 BNS or s.66C/66D are scheduled offences under the PMLA 2002 is [unverified].

### 2. Intake

- **Case-opening channel: the National Cyber Crime Reporting Portal** (cybercrime.gov.in, run by I4C under the MHA; helpline 1930).
  - Complaints are "converted into FIRs and acted on by State/UT law enforcement" [https://www.pib.gov.in/PressReleasePage.aspx?PRID=2082765&reg=48&lang=2].
  - Registration needs a valid Indian mobile number with an OTP. This is per the official FAQ as shown in search results; the page could not be fetched [https://cybercrime.gov.in/webform/FAQ.aspx] [unverified].
  - The complaint ID is sent to the registered mobile and email [https://www.cybercrime.gov.in/UploadMedia/MHA-CitizenManualReportOtherCyberCrime-v10.pdf] [unverified].
  - From Germany, connections to cybercrime.gov.in, cert-in.org.in and i4c.mha.gov.in timed out on 2026-11-17 (my own curl tests). This suggests geo-blocking, which one user report also describes [https://www.linkedin.com/pulse/report-online-scam-cybercrime-portal-india-follow-steps-singh] [unverified].
  - A lawyer's blog claims foreign mobile numbers are accepted [https://bestcybercrimelawyer.in/2025/12/03/how-to-file-a-cyber-complaint-in-india/] [unverified].
  - The portal is built around victims; an anonymous "report" category exists [unverified].
- **Direct FIR (police station or e-FIR).** BNSS s.173(1): information on a cognizable offence "irrespective of the area where the offence is committed, may be given orally or by electronic communication". Electronic information is recorded only "on being signed within three days by the person giving it" [https://indiacode.ecourtsindia.com/bnss/section/173/]. In practice this needs physical or a lawyer's presence in India [unverified]. Nothing in the text requires the informant to be a victim.
- **Takedown, not case-opening: CERT-In.** Reports go to incident@cert-in.org.in. The official form accepts reports from individuals or organisations, including reports about incidents affecting another entity, and lists "Identity Theft, spoofing and phishing attacks" [https://www.cert-in.org.in/PDF/certinirform.pdf]. CERT-In is a MeitY body under IT Act s.70B with no power to investigate offences.

### 3. Legality vs opportunity

- **Registration is mandatory in principle.** Lalita Kumari v. Govt. of U.P. (Constitution Bench, 12 Nov 2013) held that FIR registration is mandatory when information discloses a cognizable offence [https://indiankanoon.org/doc/10239019/].
- **BNSS s.173(3) adds discretion.** For offences punishable with 3 to under 7 years, the station officer may, with a DSP's permission, run a 14-day preliminary enquiry "to ascertain whether there exists a prima facie case" [https://indiacode.ecourtsindia.com/bnss/section/173/]. That band covers s.66, 66C, 66D and BNS s.318(4).
- **Thresholds.** No published minimum-loss threshold or policy on foreign-victim cybercrime was found. Policing is a State subject, and I4C's tools are built around Indian victims (the 1930 helpline, financial fraud) [https://www.pib.gov.in/PressReleasePage.aspx?PRID=2082765&reg=48&lang=2].

### 4. Domestic powers

- **Production orders.** BNSS s.94 lets a court or a police station's officer in charge require production of any document or "electronic communication … likely to contain digital evidence" by written order, physical or electronic. No judicial order is needed [https://indiankanoon.org/doc/144691869/]. This covers subscriber, payment and log data held by PDR or a host.
- **Interception and monitoring** of content need a government order under IT Act s.69 [https://www.indiacode.nic.in/bitstream/123456789/13116/1/it_act_2000_updated.pdf].
- **Preservation and retention.**
  - IT Act s.67C makes intermediaries preserve information as prescribed, with criminal liability for breach (same source).
  - CERT-In Directions of 28 Apr 2022 (s.70B(6)) require all service providers, intermediaries and data centres to keep ICT logs for "a rolling period of 180 days … within the Indian jurisdiction" (para iv). Data centres, VPS, cloud and VPN providers must keep validated subscriber names, hire periods, allotted IPs, the email address, IP and timestamp used at registration, and validated address and phone for 5 years (para v) [https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf].
  - Unlike US §2703(f), there is no specific preservation order for police.
- **Speed:** no official figures were found [unverified].

### 5. Cooperation

- **Budapest Convention:** India is not a party and is not an observer. "India has not acceded to the Budapest Convention … However, India is a member of the G7 24/7 network" [https://www.coe.int/en/web/octopus/-/india]. It has no Second Additional Protocol, and the EU e-Evidence Regulation does not apply.
- **24/7 point:** the CBI is the nodal point for data-preservation requests through the G7 24/7 network, and runs Interpol's National Central Bureau [https://www.pib.gov.in/PressReleasePage.aspx?PRID=2082765&reg=48&lang=2].
- **Germany–India MLAT.**
  - Signed 24 Oct 2024 in New Delhi. Germany's ratifying law is BGBl. 2025 II Nr. 292 of 28 Nov 2025 [https://www.recht.bund.de/bgbl/2/2025/292/regelungstext.pdf].
  - The treaty enters into force 30 days after the instruments of ratification are exchanged (Art. 27(2)). No entry-into-force notice was found [unverified whether in force].
  - Art. 2 no. 11 covers "freezing, attaching and seizing electronically stored data".
  - Art. 16 allows spontaneous exchange of information without a request, with "special consideration" to "cyber crimes".
  - Central Authorities are the Federal Office of Justice for Germany and the Ministry of Home Affairs for India (Art. 3).

### 6. Evidence of real practice

- **Operation Chakra-II (Oct 2023).** The CBI searched 76 locations in five cases, including international tech-support fraud by people impersonating "a global IT major". It named the FBI, Interpol, the NCA, the Singapore Police Force and Germany's BKA as partners, and referred to private-sector support [https://www.pib.gov.in/PressReleasePage.aspx?PRID=1969132&reg=48&lang=2].
- **Later Chakra cases on FBI input,** such as Noida in Dec 2025, are known only through media reports [https://www.freepressjournal.in/india/cbi-dismantles-major-transnational-cyber-crime-network-at-noida] [unverified, not on a primary page].
- **No case was found** where Indian police acted on a foreign private tip about phishing websites hosted or registered in India. Practice concerns call centres and money flows, mostly on input from foreign law enforcement.

### 7. Verdict

The law allows it (IT Act s.75), but a direct report from phishing.support is very unlikely to open a case.

- The portal needs an Indian mobile number and appears to block foreign IPs.
- An e-FIR must be signed within 3 days in India.
- Offences in the 3–7 year band can be parked in a preliminary enquiry.
- India's victim-centred priorities and the absence of any domestic victim make it worse.

A CERT-In email works only for takedown. The better route is the Bavarian prosecutor (ZCB/LKA), which can go through the BKA/Interpol to the CBI, the G7 24/7 network for preservation, and spontaneous information under Art. 16 of the MLAT once it is in force. Formal requests under the MLAT go through the Federal Office of Justice to the MHA.


---

## Canada

### 1. Jurisdiction

- **Territorial scope.** Criminal Code s. 6(2): "no person shall be convicted … of an offence committed outside Canada" unless an Act provides otherwise. [https://laws-lois.justice.gc.ca/eng/acts/c-46/section-6.html]
- **When an offence counts as committed in Canada.** *Libman v The Queen*, [1985] 2 SCR 178, sets the test. An offence is within Canadian jurisdiction if "a significant portion of the activities constituting that offence took place in Canada", which gives a "real and substantial link", provided that prosecuting does not offend international comity. In *Libman* itself, a Toronto boiler room defrauded only US victims, and Canada still had jurisdiction. [https://www.canlii.org/en/ca/scc/doc/1985/1985canlii51/1985canlii51.html; SCC case page https://scc-csc.ca/cases-dossiers/search-recherche/18381/] (The CanLII page could not be fetched; the quote is confirmed through secondary sources.)
- **Application to hosted phishing infrastructure** [unverified, my inference]. An operator, or a hosting or registrar account, run from Canada would very likely meet the *Libman* test even though all victims are German. A server in Canada rented by a foreign actor is a weaker link, and comity concerns could arise.
- **Substantive offences:**
  - **s. 342.1** unauthorized use of a computer, up to 10 years. Para. (d) covers anyone who "uses, possesses, traffics in … a computer password". [https://laws-lois.justice.gc.ca/eng/acts/c-46/section-342.1.html]
  - **s. 342.2** possession, sale or distribution of a device "designed or adapted primarily" to commit s. 342.1 or s. 430 offences, up to 2 years. "Device" includes a computer program, so it covers phishing kits. [https://laws-lois.justice.gc.ca/eng/acts/c-46/page-55.html]
  - **s. 380** fraud. [https://laws-lois.justice.gc.ca/eng/acts/c-46/section-380.html]
  - **s. 402.2(1)** identity theft: "obtains or possesses another person's identity information". Under s. 402.1 identity information expressly includes "user name … financial institution account number … password". **s. 402.2(2)** trafficking in identity information, up to 5 years. **s. 403** identity fraud, up to 10 years. [https://laws-lois.justice.gc.ca/eng/acts/c-46/page-61.html]
  - **s. 430(1.1)** mischief in relation to computer data. [https://laws-lois.justice.gc.ca/eng/acts/c-46/page-63.html]
  - **s. 462.31(1)** money laundering. It covers proceeds of an act "anywhere" that would be a designated offence in Canada, up to 10 years (14 years in connection with a criminal organization). [https://laws-lois.justice.gc.ca/eng/acts/c-46/section-462.31.html]

### 2. Intake

**Case-opening channel: none that is national.** Investigation is done by local police.

- **CAFC report page.** It says "It's the role of your local police to investigate"; the Canadian Anti-Fraud Centre (CAFC) only keeps a "central repository". [https://antifraudcentre-centreantifraude.ca/report-signalez-eng.htm]
- **Who can report.** "Whether you are a victim or a witness, you can report" (same page), and the reporter does not need to be a victim.
- **RCMP/CAFC "Report Cybercrime and Fraud" system** (RCMP's National Cybercrime Coordination Centre, NC3, launched in 2025):
  - URL: https://reportcyberandfraud.canada.ca/
  - Built "for Canadians and businesses"; anonymous reports are allowed.
  - Purpose: to link reports "across Canada and internationally" and to prioritize threats.
  - Language: English and French [inferred from the bilingual pages].
  - [https://rcmp.ca/en/federal-policing/cybercrime/national-cybercrime-coordination-centre/report-cybercrime-and-fraud]
- **Gaps in the published information.** No official page addresses foreign reporters, third-party or organisational reporters abroad, attachment upload, case numbers or feedback. All of these are [unverified]. The phone line is 1-888-495-8501, Mon–Fri 10:00–16:45 ET (same CAFC page).
- **What this means for phishing.support:** the report goes into an intelligence database and does not open a case.
- **Takedown and CERT channel, not a case-opening channel.** The Canadian Centre for Cyber Security's reporting form offers "An Individual" or "A business or organization in Canada". It says nothing about takedowns or forwarding to police. [https://www.cyber.gc.ca/en/incident-management]
- **Registrar channel.** For Tucows, the route is its registrar abuse process (ICANN). This is not a police channel. [unverified]

### 3. Legality vs opportunity

Canada follows the opportunity principle. There is no duty to investigate.

- **Police discretion** is recognized but must be justified "subjectively and objectively". *R v Beaudry*, 2007 SCC 5. [https://www.canlii.org/en/ca/scc/doc/2007/2007scc5/2007scc5.html]
- **Prosecution test.** The Public Prosecution Service of Canada (PPSC) Deskbook, guideline 2.3 "Decision to Prosecute", requires a "reasonable prospect of conviction" and that prosecution serve the "public interest". [https://www.ppsc-sppc.gc.ca/eng/pub/fpsd-sfpg/fps-sfp/tpd/p2/ch03.html] Most Criminal Code prosecutions are handled by provincial Crown offices.
- **Thresholds.** I found no published loss threshold or policy on cybercrime with only foreign victims. [unverified] The CAFC advises reporting to local police "particularly if you have lost money", which suggests a victim and loss focus. [https://antifraudcentre-centreantifraude.ca/features-vedette/2026/10/reporting-cybercrime-signaler-cybercriminalite-eng.htm]

### 4. Domestic powers

**Preservation demand, s. 487.012.** A peace officer can issue it without a judge. It expires after 21 days for a domestic offence. It also works for an offence "committed under a law of a foreign state" where "an investigation is being conducted" in that state, and then lasts **90 days**. [https://laws-lois.justice.gc.ca/eng/acts/c-46/section-487.012.html]

**Preservation order, s. 487.013.** Issued by a judge on "reasonable grounds to suspect", including for foreign offences, and expires after 90 days. [https://laws-lois.justice.gc.ca/eng/acts/c-46/section-487.013.html]

**Production orders:**

| Section | What it obtains | Standard | Source |
|---|---|---|---|
| s. 487.014 | Any document or data (subscriber records, logs, content held) | "Reasonable grounds to believe"; offence under an Act of Parliament only | https://laws-lois.justice.gc.ca/eng/acts/c-46/section-487.014.html |
| s. 487.015 | Tracing a communication | Not checked | — |
| s. 487.016 | Transmission data | "Reasonable grounds to suspect" | https://laws-lois.justice.gc.ca/eng/acts/c-46/section-487.016.html |
| s. 487.017 | Tracking data | Not checked | — |
| s. 487.018 | Financial data from banks and reporting entities, including virtual-currency accounts: account number, type, status, open/close dates, plus date of birth and address | "Reasonable grounds to suspect" | https://laws-lois.justice.gc.ca/eng/acts/c-46/section-487.018.html |

**Voluntary disclosure and preservation, s. 487.0195.** No order is needed to ask a provider to preserve data voluntarily or hand over data it may lawfully disclose, and the provider incurs no liability. [https://laws-lois.justice.gc.ca/eng/acts/c-46/section-487.0195.html]

**Charter limits.** Subscriber information (*R v Spencer*, 2014) and IP addresses (*R v Bykovets*, 2024 SCC 6) both attract a reasonable expectation of privacy, so a judicial order is required. [https://decisions.scc-csc.ca/scc-csc/scc-csc/en/20302/1/document.do]

**Speed.** No statutory deadline for compliance; I found no official figure. [unverified]

**Data retention.** There is no general retention obligation. Bill C-22 (Lawful Access Act, 2026) would allow retention regulations of up to 6 months. It is still in Senate committee and has no royal assent. [https://www.parl.ca/legisinfo/en/bill/45-1/c-22]

### 5. Cooperation

- **Budapest Convention (CETS 185).** Canada signed on 23/11/2001, ratified on 08/07/2015, in force since **01/11/2015**. Germany has been a party since 01/07/2009. [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185]
- **Second Additional Protocol (CETS 224).** Canada signed on 20/06/2023 and has not ratified. Germany signed on 27/01/2023 and has not ratified. The protocol is not in force: 4 of the 5 needed ratifications. [https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224]
- **EU e-Evidence Regulation.** Canada is not bound. However, the Regulation reaches service providers that offer services in the Union, so a German prosecutor could address Tucows' EU establishment or legal representative, if one exists. [unverified]
- **Bilateral MLA treaty.** The Canada–Germany Treaty on Mutual Assistance in Criminal Matters was signed at Tremblant on 13 May 2002. It enters into force one month after the exchange of ratifications (Art. 21(2)); the date is not shown. Requests go through the Minister of Justice of Canada and the German Federal Ministry of Justice (Art. 11), with Interpol for urgent cases. The treaty has no article on spontaneous information. [https://www.treaty-accord.gc.ca/text-texte.aspx?id=104860]
- **24/7 contact point (Art. 35).** The RCMP NC3 24/7 Data Preservation Unit in Ottawa. [https://rm.coe.int/competent-authorities-july-2025-web/1680b69201]

### 6. Evidence of real practice

- **Project NOVA, April 2025** (RCMP NC3, CAFC and Sûreté du Québec). Follow-up on LabHost users after the UK-led Operation STARGREW takedown, which Europol supported. Results: 10 search warrants and 118+ enforcement actions. NC3 worked "with organizations that were impersonated" and thanked the Cyber Defence Alliance and private-sector partners. The victims were Canadians. [https://rcmp.ca/en/news/2025/04/project-nova-canadian-law-enforcement-continues-disruption-criminal-labhost-users]
- **Project CODA (Ontario Provincial Police), 2021.** Started when the "FBI contacted the OPP in January 2020". Charges included s. 342.1 and s. 342.2. [https://www.cbc.ca/news/canada/ottawa/ottawa-man-cybersecurity-ransomware-arrests-1.6276803] (press report; I did not find the OPP release)
- **GameOver Zeus / CryptoLocker, 2014.** The RCMP took down Montreal servers after an FBI tip. [https://www.theglobeandmail.com/news/national/rcmp-shuts-down-2-computer-servers-in-russian-cyber-crime-crackdown/article18953614/] (press)
- **Not found:** any case opened because of a foreign private reporter's tip about Canadian-hosted phishing aimed at foreign victims. [unverified]

### 7. Verdict

**A direct report from phishing.support is very unlikely to open a case in Canada.** The national channel is an intelligence repository for Canadians and businesses. Investigation sits with local police, who have discretion and focus on victims and losses. German victims and a one-person foreign reporter give little reason to prioritize. The only meaningful link would be a Canada-based operator. A data report is still worth filing because NC3 uses it to link related cases.

**Better route:** report to the Bavarian authority (ZCB / LKA Bayern). They can then:

- ask the NC3 24/7 unit to issue a **s. 487.012 preservation demand** (90 days for a foreign offence, with the German investigation as the basis);
- send spontaneous information under Budapest Art. 26 through BKA–RCMP police channels or Interpol;
- follow with an MLA request under the 2002 treaty for production orders against Tucows or the Canadian host;
- where a provider offers services in the EU, consider an e-Evidence order (EPOC).

In parallel, phishing.support can send registrar abuse reports to Tucows for takedown.


---

## Ranked best bets

Ranked by expected effect per effort for a one-person service. This is an assessment.

1. **German case first, then EPOC to the contracting entity.**
   - **Why it ranks first:** it gives the result the idea is after (subscriber, payment and log data obtained without slow MLA) without needing any foreign police to open a case.
   - **What phishing.support does:** for every provider in a campaign, the dossier names the **contracting entity** (from the provider's terms, e.g. Hostinger International Ltd, Cyprus) and its e-Evidence addressee or LE contact. It lists the identifiers the order needs (account, domain, IP, UTC timestamps). The prosecutor (e.g. ZCB Bamberg) can then issue EPOCs without research.
   - **Covers:** the US platforms, Hostinger, OVHcloud, the Alibaba EU entities, and the EU registrars.
2. **Ask for preservation via the BKA 24/7 point in the same message as the complaint.**
   - Germany cannot issue EPOC-PRs yet, so Budapest Art. 29 is the preservation route. It works for the USA (2703(f)), Lithuania, the Netherlands (art. 126ni Sv), France, the UK (voluntary), Turkey and Canada.
   - Canada's s.487.012 demand explicitly covers foreign offences for 90 days.
   - The dossier should flag short provider windows: 20i keeps hosting data 30 days, Hostinger deletes customer data 30 days after termination.
3. **Suggest spontaneous information or a Verfolgungsersuchen only where the hosting state has its own link.** Examples: a complicit or bulletproof hoster, an operator or money mule there, local victims or brands, or an existing local case. Without such a link, Reg. 2024/3011 Art. 12(2)(c) and the opportunity principle make refusal likely. Cut a "country slice" per infrastructure country, as described in the sibling report.
4. **Direct parallel report only to Lithuania and Turkey, and only for large clusters.** These are the two legality-principle countries where a foreign non-victim can file in writing and receives a formal decision.
   - **Lithuania:** a signed letter or a qualified-e-signature e-mail to the Criminal Police Bureau's cyber unit (cyberpolice@policija.lt), quoting the German case number. Hostinger's data sits in Cyprus, so expect "opened, then suspended" unless the server or operator is in Lithuania.
   - **Turkey (Corelux):** a Turkish-language written ihbar to the prosecutor's office where the server is, quoting the German case number. Risk: dismissed as "abstract and general" under CMK 158(6).
   - **Cost:** a translation and a human signature per case. Not automatable at scale.
5. **Intelligence-only drops where they cost nothing:** Singapore I-Witness (attachments allowed, anonymous), the Canadian CAFC/NC3 portal, and a French PHAROS report for OVH-hosted sites. They open no case but may link to other reports.
6. **Takedown only:** China (CNCERT, the anti-phishing alliance, Alibaba abuse) and Russia (RU-CERT, hoster abuse). Do not send identified criminal reports to Russia: it exposes the reporter and has no realistic upside.

**Not worth doing:** direct reports to Dutch, Irish, US, UK, Indian or Canadian police. Their channels either reject foreign reporters, are built for victims, or act only through their own priorities. For the Netherlands, everything goes through the German prosecutor's direct judicial channel.

## Implications for the tool

- Store per infrastructure item: physical location (if known, e.g. origin IP behind Cloudflare), contracting entity, ASN country, provider LE or e-Evidence contact, and known data retention.
- Generate per campaign: an EPOC-ready identifier list per provider, a 24/7 preservation list ordered by deletion risk, and a "country slice" in English for any state with its own link.
- Keep the Lithuania and Turkey direct-report templates as manual, human-signed options.

## Open questions

- **Hostinger:** which entity actually controls customer and payment data, and whether UAB Hostinger (Lithuania) holds it in "possession or control" for Lithuanian orders. Which data centre hosts a given IP?
- **Lithuania:** is a written report from a foreign non-victim organisation accepted in English or German, or must it be in Lithuanian? Does the Criminal Police Bureau's cyber unit reply with a registration number? Only a test report answers this.
- **Turkey:** the current Law 5651 retention period (regulation text); whether Corelux has an EU addressee; and the EGM online ihbar module requirements (form not reachable).
- **EU addressees:** whether 20i, Tucows, Gname, PublicDomainRegistry, NameSilo and Dynadot have designated an e-Evidence addressee. Each provider's legal or LE page needs checking.
- **India:** the entry-into-force date of the DE–IN MLAT (signed 24 Oct 2024; German ratification law BGBl. 2025 II Nr. 292).
- **Canada:** the entry-into-force date of the 2002 DE–CA treaty (sources say 2004).
- **New IRG:** the exact final wording of § 120 IRG (spontaneous transmission threshold) and the promulgation date.
- **Russia:** whether Germany processes any MLA with Russia at all since 2022. No primary statement found.
- **Infrastructure behind Cloudflare:** how often phishing.support can determine the physical origin country at all. Production data mostly shows Cloudflare, so for most campaigns the "hosting country" is unknown until a provider order reveals the origin.
- **No precedent found** in any country for a case opened on a foreign private reporter's direct complaint about phishing infrastructure. Every documented case came through foreign authorities, Europol or Interpol, or large vendors.
