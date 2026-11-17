# Data protection for perpetrator data: what phishing.support may collect, keep, send and publish

Date: 2026-11-17

**Question:** phishing.support is run by one natural person (Samuel Scheit, Landkreis München) as a private, non-commercial, privately financed service. It does the following:

- visits phishing sites;
- captures them (MHTML, screenshots, data-flow records made with synthetic canary credentials);
- extracts indicators that may point to identifiable perpetrators: domains, IPs, RDAP/WHOIS registrant data, Telegram bot tokens and chat IDs, Discord webhooks, IBANs and wallets, sender addresses, kit author handles;
- groups the sites into campaigns and publishes a public page per campaign;
- sends takedown reports to providers worldwide;
- refers campaigns to ZCB Bamberg as a Strafanzeige, with later Nachträge.

Planned:

- per-country annexes routed through the German authority;
- possibly direct complaints in Lithuania or Turkey;
- MISP/STIX sharing with authorities and CERTs;
- possibly contact with Europol.

What does the GDPR/BDSG require for each of these steps, where is the law unsettled, and what should change?

This report follows on from [criminal-referral-routes.md](criminal-referral-routes.md) and [multi-country-coordination.md](multi-country-coordination.md). The latter's §5.3 left Art. 10 GDPR open; this report takes that question up.

**This is research, not legal advice.** It does not replace a lawyer's opinion. Where it says "lawful" or "risk", that is a research assessment.

**Markers:**

- **[unverified]**: the claim is not confirmed on a primary source. It comes from a secondary source, a commentary quoted second-hand, or a search summary.
- **Assessment**: my own reasoning from the sources, not a sourced statement.
- **Unsettled**: courts or authorities have not decided the point, or sources disagree.

## Summary

1. **The GDPR applies in full.**
   - The household exemption does not cover publishing on the internet to an indefinite audience. It also does not cover systematic processing that is directed at the public and at third parties.
   - Being non-commercial does not change this.
   - The operator is a "nichtöffentliche Stelle" (§ 2(4) BDSG), and the competent supervisory authority is the **BayLDA** in Ansbach (Art. 18(1) BayDSG, § 40 BDSG).
2. **Much of the indicator data is personal data**, and some of it concerns **people who are not perpetrators at all**:
   - money-mule account holders behind IBANs;
   - owners of hijacked sites and mail accounts;
   - people whose identity was used in RDAP records;
   - victims whose addresses appear in captured pages.
3. **Art. 10 GDPR very likely applies** to data that links an identifiable person to a phishing offence.
   - The CJEU reads "offences" autonomously and broadly:
     - C-439/19 covers administrative penalty points;
     - C-136/17 covers proceedings "regardless of whether" the offence was proven.
   - German commentaries disagree on whether pure suspicion is covered.
   - The EDPB has announced an **Opinion on the scope of Art. 10** that is not yet adopted. This is **unsettled**, so the safe course is to treat the data as Art. 10 data.
4. **No German statute expressly authorises a private person to process Art. 10 data in order to fight crime. This is a real gap.**
   - § 24 BDSG covers changes of purpose, and its paragraph 2 opens it only for Art. 9 data.
   - § 22 BDSG covers Art. 9 data only.
   - § 138 StGB does not list any phishing offence.
   - The HinSchG covers only information obtained at work.
   - What remains:
     - **Reporting to authorities** is arguably covered: § 158 StPO plus Recital 50, under the authority's control. This is low risk in practice.
     - **Takedown notices** to EU-facing hosting providers can lean on the DSA notice-and-action framework (Art. 16 DSA). This is medium–low risk.
     - **Public naming of suspects** has no basis at all. This is high risk.
5. **The EDPB's final legitimate-interest guidelines (1/2024 v2.0, adopted 10 Nov 2026) cut against the current design.**
   - "Generalised and preventive collection of personal data … to systematically report possible criminal acts" is not what Recital 50 envisages (para. 128).
   - Art. 6(1)(f) is a fit only for occasional reports (para. 131).
   - phishing.support's whole purpose is systematic reporting. Its Art. 6(1)(f) case therefore has to rest on its own specific interests (para. 19): its anti-phishing activity, the users who submitted reports, and the impersonated brands and victims. It cannot rest on the general public interest (para. 22).
6. **Publishing perpetrator indicators is the highest-risk step.**
   - The public page and the public `evidence.zip` currently publish **live Telegram bot tokens, Discord webhook tokens, chat IDs and IBANs**.
   - CJEU C-439/19 held public disclosure of offence data to anyone disproportionate where less intrusive means exist.
   - C-474/24 (14 Jul 2026) requires an individual balancing before publication and a time limit.
   - C-199/24 (9 Jul 2026) narrows the "journalistic purposes" exception to edited, fact-checked content.
   - The BayLDA calls public "Fahndungsaufrufe" by private bodies unlawful and fines them "in der Regel" (14th Tätigkeitsbericht 2024, ch. 17.1).
   - Publishing a bot token also gives anyone access to the stolen victim data that flows into the bot.
7. **Transfers outside the EU.**
   - Takedown reports to DPF-certified US providers and to providers in adequate countries are covered by Art. 45.
   - China, Turkey and similar countries need Art. 49(1)(d), which has to rest on a public interest recognised in EU or German law, plus minimisation.
   - Repeated direct transfers to foreign prosecutors (Turkey) do not fit Art. 49. Route them through the German authority.
8. **Duties:**
   - Records of processing (Art. 30) are **required**, because the processing is regular and includes Art. 10 data.
   - A **DPIA** is very likely required (WP248 criteria; Art. 35(3)(b) if the scale counts as "large").
   - If a DPIA is required, **§ 38(1) sentence 2 BDSG requires a data protection officer regardless of headcount** (an external DPO is fine).
   - Art. 14 information to perpetrators can be withheld under Art. 14(5)(b) and § 33(1) No. 2(b) BDSG. In return, the information must be published (§ 33(2) BDSG) and the reasons documented.
   - A retention limit is required (Art. 5(1)(e)).
9. **The site has no privacy policy and no Impressum.** The only text is a one-line "Privacy note" in [About.tsx](/Users/user/Developer/Developer/ai/phishing_reporter/src/components/About.tsx:47). That breaches Art. 13/14 for every user who submits an email, and § 18(1) MStV / § 5 DDG for the imprint.

## 0. What the product does today (repo facts relevant to the analysis)

| Fact | Where | Why it matters |
|---|---|---|
| No privacy policy and no Impressum page; the only text is "Privacy note: Only submit emails or links you're allowed to share publicly." | [About.tsx](/Users/user/Developer/Developer/ai/phishing_reporter/src/components/About.tsx:47), no `datenschutz`/`privacy`/`impressum` route in `src/app` | Art. 12–14 GDPR, § 33(2) BDSG, § 18 MStV |
| The public `evidence.zip` serves "the same dossier and files the authorities get. What the operators published on their pages (bot tokens, accounts) is published here as it was found." | [evidence.zip/route.ts](/Users/user/Developer/Developer/ai/phishing_reporter/src/app/campaigns/[id]/evidence.zip/route.ts:10) | Publication of Art. 10 data, secrets, and possibly victim data contained in MHTML |
| The public page shows Telegram bot ID, username, **chat ID, token**; Discord webhook ID, server, channel, **token**; IBANs and wallets with site counts | [public_view.ts](/Users/user/Developer/Developer/ai/phishing_reporter/src/lib/campaign/public_view.ts:118), [CampaignView.tsx](/Users/user/Developer/Developer/ai/phishing_reporter/src/app/campaigns/[id]/CampaignView.tsx:257) | Public naming of identifiable persons as suspects; a public token gives anyone read access to victims' stolen credentials and lets anyone destroy the evidence |
| Campaign and submission pages are `index: true` | [campaigns/[id]/page.tsx](/Users/user/Developer/Developer/ai/phishing_reporter/src/app/campaigns/[id]/page.tsx:25), [submissions/[id]/page.tsx](/Users/user/Developer/Developer/ai/phishing_reporter/src/app/submissions/[id]/page.tsx:36) | Search-engine reach multiplies the impact (C-136/17) |
| Recipient addresses are redacted from submitted mails; same-site data destinations are reduced to `https://<site>/path` | [mail_ai.ts](/Users/user/Developer/Developer/ai/phishing_reporter/src/lib/mail_ai.ts:122), [public_view.ts](/Users/user/Developer/Developer/ai/phishing_reporter/src/lib/campaign/public_view.ts:210) | Good minimisation that already exists |
| No retention or deletion of submissions, captures or indicators (only the exfiltration download samples have a retention setting) | grep for retention/purge in `src/lib` | Art. 5(1)(e) |
| Content is analysed with the OpenAI API | `package.json` | Processor in a third country; must be named in the privacy policy |
| Criminal referrals are signed by a configured natural person | [complainant.ts](/Users/user/Developer/Developer/ai/phishing_reporter/src/lib/referral/complainant.ts:1) | Named complainant: § 158 StPO route, § 164 StGB exposure |

## 1. Household exemption and supervisory authority

**Rule:**

- The GDPR does not apply to processing "by a natural person in the course of a purely personal or household activity" (Art. 2(2)(c)).
- Recital 18 limits this to activity "with no connection to a professional or commercial activity", such as correspondence or address books (GDPR, EUR-Lex: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679).
- § 1(1) sentence 2 BDSG repeats the exclusion for natural persons acting for "ausschließlich persönliche oder familiäre Tätigkeiten" (https://www.gesetze-im-internet.de/bdsg_2018/__1.html).

**Case law:**

- *Lindqvist*, C-101/01, para. 47: the exception covers only "activities which are carried out in the course of private or family life". That "is clearly not the case" for publication on the internet that makes data "accessible to an indefinite number of people" (quoted via https://websites.umich.edu/~jdlitman/classes/cyber/cases/Lindqvist.pdf; paragraph number via secondary sources).
- *Ryneš*, C-212/13, paras. 29–31: the exception is narrowly construed, and "purely" excludes mixed activities. Para. 33: monitoring directed outward to public space is not household activity (https://www.dpcuria.eu/case?reference=C-212%2F13, via search summary **[unverified paragraph numbering]**).

**Application:**

- phishing.support publishes campaign pages indexed by search engines.
- It sends data to providers and authorities in many countries.
- It runs a public intake (report@phishing.support).

**Assessment:** none of this is "purely personal or household". The absence of payment is irrelevant, because Recital 18 excludes activity connected to *professional or commercial* activity, while *Lindqvist* turns on the audience, not on money. The GDPR applies in full.

**Who supervises:**

- The operator is a "nichtöffentliche Stelle" because § 2(4) BDSG covers "natürliche und juristische Personen … des privaten Rechts" (https://www.gesetze-im-internet.de/bdsg_2018/__2.html).
- Art. 18(1) BayDSG: "Das Landesamt für Datenschutzaufsicht … ist Aufsichtsbehörde nach Art. 51 DSGVO und nach § 40 des Bundesdatenschutzgesetzes für nicht öffentliche Stellen" (https://www.gesetze-bayern.de/Content/Document/BayDSG-18).
- The **BayLDA (Ansbach)** is therefore competent. It is also the authority that would receive complaints from data subjects (Art. 77).
- Note: where Art. 38 BayDSG (the journalistic exception) applies, Art. 18(1) sentence 2 BayDSG switches off most of the BayLDA's investigative and corrective powers. See §5(g).

## 2. Which of the captured data are personal data, and whose

**Rule:** data are personal if the person is identifiable by means "reasonably likely to be used". That includes legal means through third parties such as an authority and an ISP (*Breyer*, C-582/14, paras. 48–49; https://ipcuria.eu/case?reference=C-582%2F14, via search summary).

*EDPS v SRB*, C-413/23 P (4 Sep 2025), adds that identifiability can differ between controller and recipient, but the controller's view at collection governs its own duties (https://curia.europa.eu/site/upload/docs/application/pdf/2025-09/cp250107en.pdf; summaries by Jones Day and Bird & Bird **[unverified against the full text]**).

**Assessment:** phishing.support collects indicators *in order to* have authorities identify the person behind them. By the *Breyer* logic, the indicators are personal data in its hands even when the name is unknown.

| Data | Personal data? | Whose? | Art. 10 risk |
|---|---|---|---|
| Phishing URL, domain, screenshot | Usually yes, indirectly: identifies the registrant/operator via registrar data | Operator, **or** the owner of a hijacked legitimate site | Yes for an operator; wrong attribution for a hijacked site |
| Hosting server IP, ASN | Often a legal person's address block (not personal). A VPS IP leased by a natural person is personal via the provider | Hoster's customer | Low–medium |
| RDAP/WHOIS registrant name, e-mail, address | Yes | Registrant, often a **stolen or fake identity** or a privacy service | High if published |
| Telegram bot ID/username/chat ID, Discord webhook/server/channel IDs | Yes (pseudonymous account identifiers) | Operator or kit buyer | Yes |
| Bot/webhook **tokens** | Yes, and also a secret credential | Operator, and indirectly the **victims** whose stolen data sits in the chat | Yes, plus a security problem (Art. 32) |
| IBAN | Yes | Account holder, often a **recruited or deceived money mule** or an identity-theft victim | High |
| Crypto wallet | Pseudonymous personal data | Operator or launderer | Medium |
| Sender e-mail address of a phishing mail | Yes | Often a **compromised or spoofed innocent account** | High wrong-attribution risk |
| Kit author handle | Yes (pseudonym, linkable) | Kit seller | Yes |
| Victim identifiers in personalised lure URLs, pre-filled fields, captured pages | Yes | **Victims** | Not Art. 10 (victims are not covered), but confidential |
| E-mail submitted by a user (headers, recipient) | Yes | **The reporting user**, the recipient, third parties named in the mail | No |
| Brand names, logos | Not personal data (trademark/copyright questions only) | — | — |

The Liechtenstein DPA's reading is that Art. 10 covers perpetrators, instigators and accessories, "allenfalls" suspects, but "nicht jedoch … Zeugen, Opfer[n] oder sonstige[n] Beteiligte[n]" (https://www.datenschutzstelle.li/datenschutz/themen-z/art-9_u_art-10-dsgvo). Victims' data therefore falls under the ordinary rules.

## 3. Does Art. 10 GDPR apply to suspicion data held by a private party?

**Text:** Art. 10 reads: "Processing of personal data relating to criminal convictions and offences or related security measures based on Article 6(1) shall be carried out only under the control of official authority or when the processing is authorised by Union or Member State law providing for appropriate safeguards … Any comprehensive register of criminal convictions shall be kept only under the control of official authority." (EUR-Lex, above.)

Art. 10 is no stand-alone prohibition like Art. 9(1). It is an *additional* condition on top of an Art. 6(1) basis.

### 3.1 CJEU case law

- **C-439/19 *Latvijas Republikas Saeima* (Grand Chamber, 22 Jun 2021)** (https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62019CJ0439):
  - Art. 10 is "intended to ensure enhanced protection" because the data relate "to behaviour that gives rise to social disapproval" and access "is liable to stigmatise the data subject" (paras. 74–75).
  - "Offences" refers exclusively to *criminal* offences (para. 77), but the term is autonomous. National labels do not decide; nature, purpose and severity do (paras. 85–91).
  - Road-traffic offences carrying penalty points are covered (paras. 92–94).
  - On publication:
    - making such data available to "any person" without a specific interest is disproportionate (paras. 112–118, 122);
    - the aim could be achieved "by other means less restrictive" (para. 110);
    - identifying bad-faith offenders does not have to be done by or shared with "the general public" (para. 114).
- **C-136/17 *GC and Others* (Grand Chamber, 24 Sep 2019)** (https://www.dpcuria.eu/case?reference=C-136%2F17; paraphrase, since the verbatim text was not retrievable):
  - Para. 72: information about legal proceedings against a person (investigation, trial and any conviction) is data on "offences" and "criminal convictions" under Art. 8(5) of the Directive and Art. 10 GDPR. This holds **whether or not the offence was shown to have been committed**.
  - Paras. 77–78: when weighing, the relevant factors are the seriousness of the offence, the stage and outcome of proceedings, the time elapsed and public interest. Results must reflect the current legal position.
- **C-740/22 *Endemol Shine Finland* (7 Mar 2024):**
  - Even oral disclosure is processing.
  - Art. 6(1)(e) and Art. 10 preclude disclosing criminal-proceedings data to anyone who does not show a specific interest.
  - Neither provision is "a general and absolute prohibition" when national law with safeguards authorises disclosure.

  Sources: https://ipcuria.eu/case?reference=C-740/22; https://gdprhub.eu/index.php?title=CJEU_-_C-740/22_-_Endemol_Shine_Finland_Oy (secondary).
- **C-474/24 *NADA Austria* (Grand Chamber, 14 Jul 2026)** (press release No 103/26, https://curia.europa.eu/site/upload/docs/application/pdf/2026-07/cp260103en.pdf):
  - Anti-doping sanctions "do not constitute personal data relating to criminal convictions and offences", because they target only a particular group, like disciplinary sanctions.
  - Publication remains subject to the GDPR. The publisher "must be able, prior to the publication, to carry out an individual balancing exercise".
  - Publication beyond the duration of the sanction "is disproportionate".
  - By contrast, phishing is a general criminal offence (§§ 263a, 269, 202a ff. StGB), so this case confirms that phishing data *is* on the Art. 10 side of the line. **Assessment.**
- **C-199/24 *Legal Newsdesk Sweden* (9 Jul 2026)** (press release No 100/26, https://curia.europa.eu/site/upload/docs/application/pdf/2026-07/cp260100de.pdf):
  - An online database of criminal convictions offered for payment is not "journalistic". Journalism requires dissemination of information or opinions under an editorial line, and "die dargestellten Tatsachen müssen überprüft worden sein".
  - Member States may not exclude the GDPR's remedies (Art. 77–79, 82).

### 3.2 Suspicion data (Verdachtsdaten) held by private parties: the dispute

- **Wide view: covered once there is a sufficiently concrete suspicion.**
  - Schiff, in Ehmann/Selmayr, Art. 10 Rn. 5: "bereits Daten über die Erfassung einer hinreichend konkreten Verdachtslage".
  - Frenzel, in Paal/Pauly, Art. 10 Rn. 1: "schon der bloße Verdacht … [kann] eine Stigmatisierung … bedeuten".
  - Both are quoted at https://www.datenschutz-notizen.de/strafverfahren-gegen-auflage-eingestellt-welche-daten-duerfen-verarbeitet-werden-3424248/ **[unverified: commentaries not read directly]**.
- **Narrow view: suspects, accused and defendants are not covered.**
  - Attributed to Weichert, in Kühling/Buchner, Art. 10 Rn. 6, by a publisher's page (https://www.datenschutzdigital.de/ce/artikel-10-verarbeitung-von-personenbezogenen-daten-ueber-strafrechtliche-verurteilungen-und-straftaten/detail.html) **[unverified]**.
- **Regulators:**
  - The Liechtenstein DPA: "in der Lehre umstritten" (URL above).
  - DSK and BayLDA: I found **no** DSK or BayLDA paper that decides the question.
  - The BayLDA's fining practice on private "Fahndungsaufrufe" (§5(g)) shows how it treats public accusations, but it does not cite Art. 10.
- **EDPB:** the final Guidelines 1/2024 v2.0 (10 Nov 2026), footnote 63, say: "With regard to the scope of Article 10 GDPR, the EDPB plans to adopt an Opinion following a request made under Article 64(2) GDPR" (https://www.edpb.europa.eu/system/files/2026-11/edpb_guidelines_202401_legitimateinterest_v2_en.pdf). **The question is formally open at EU level.**

**Assessment:**

- After *GC* (proceedings count regardless of proof) and *Saeima* (autonomous, protective reading aimed at stigmatisation), the narrow view is hard to hold for data that a private party *uses to accuse* an identifiable person of a specific offence. phishing.support's campaign pages and Strafanzeigen do exactly that.
- Once a Strafanzeige is filed, the data also relate to "a judicial investigation" in the *GC* sense.
- Purely technical indicators held without attribution are the weakest case for Art. 10: a URL in a blocklist, or a hash of a kit file.
- **Plan as if Art. 10 applies** to every record that links an identifiable person or account to phishing. The EDPB opinion may settle this.

## 4. Is there a legal basis that lets a private person process Art. 10 data?

Art. 10 requires either "control of official authority" or a Union or Member State law that **authorises** the processing **with appropriate safeguards**. Art. 6(1)(f) alone is not enough, because Art. 10 applies *in addition to* Art. 6(1).

| Candidate | What it says | Fit for phishing.support | Source |
|---|---|---|---|
| § 24(1) No. 1 BDSG | A non-public body may process data "zu einem anderen Zweck" if "zur Verfolgung von Straftaten erforderlich", unless the data subject's interests prevail. § 24(2) extends this to Art. 9 data only | Weak: (1) it is a *purpose-change* rule, while phishing.support collects for reporting from the start; it only fits user-submitted mails collected for analysis. (2) It does not mention Art. 10, and § 24(2) opens it for Art. 9 data only. (3) It contains no Art. 10-specific safeguards. Whether it "authorises" Art. 10 processing is **unsettled**; I found no commentary either way | https://dejure.org/gesetze/BDSG/24.html |
| § 22 BDSG | Exceptions to Art. 9(1) only (health, social security, "erhebliches öffentliches Interesse") | Not applicable to Art. 10 data. Its § 22(2) list of safeguards is a useful template for what "appropriate safeguards" look like | https://www.gesetze-im-internet.de/bdsg_2018/__22.html |
| § 158(1) StPO | "Die Anzeige einer Straftat … [kann] bei der Staatsanwaltschaft, den Behörden und Beamten des Polizeidienstes und den Amtsgerichten angebracht werden" | **Best available anchor for the act of reporting.** It is Member State law that presupposes private persons may communicate suspicion data to authorities. Safeguards: the prosecutor's control, § 164 StGB (false suspicion), § 145d StGB. Whether it meets Art. 10 is **not confirmed** by any source found; **Assessment** | https://dejure.org/gesetze/StPO/158.html |
| § 138 StGB | Duty to report planned serious crimes listed in a catalogue | **Not applicable.** The catalogue covers e.g. counterfeiting of payment cards (§ 152b), robbery and murder, but no computer fraud (§ 263a) or data offences | https://www.gesetze-im-internet.de/stgb/__138.html |
| HinSchG | Protects people who obtain information on violations "im Zusammenhang mit ihrer beruflichen Tätigkeit" (§ 1); § 10 HinSchG authorises reporting channels to process data | **Not applicable.** phishing.support's knowledge does not come from a work relationship | https://www.gesetze-im-internet.de/hinschg/HinSchG.pdf (via search summary) |
| Recital 50 GDPR | Indicating possible criminal acts to a competent authority "should be regarded as being in the legitimate interest pursued by the controller" | Explains Art. 6(1)(f), not Art. 10. But it shows that the EU legislator intended private reporting to be possible. EDPB: it covers "individual cases", not "generalised and preventive collection … to systematically report" (para. 128) | GDPR; EDPB 1/2024 v2.0 paras. 128–131 |
| Recital 49 GDPR; NIS2 Art. 29, 30(1)(b), Recital 121; § 5 BSIG | Network security is a legitimate interest; non-scope entities may share IoCs and notify CSIRTs voluntarily. NIS2 Recital 121 names "IP addresses, … URLs, domain names, email addresses" | Strong for **Art. 6(1)(f)** when sharing technical indicators with CERTs and BSI (§ 5 BSIG makes the BSI the central office for third-party reports). These provisions do not address Art. 10 | NIS2: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32022L2555; § 5 BSIG: https://www.gesetze-im-internet.de/bsig_2025/__5.html (via search summary) |
| DSA Art. 16 | Hosting providers must let "any individual or entity" notify illegal content electronically, with an explanation, the exact URL and a good-faith statement. The provider must decide diligently and inform the notifier | **Good anchor for takedown notices to hosting providers** offering services in the EU. It is Union law that institutionalises private notices of illegal content, with safeguards (Art. 16(6), 17, 20, 23). It does not reach registrars in all cases, nor non-EU-facing services. That it satisfies Art. 10 is **Assessment** | https://www.eu-digital-services-act.com/Digital_Services_Act_Article_16.html (secondary copy of the text) |
| "Under the control of official authority" | — | Covers processing *by* or *for* the authority after receipt (that processing is then under the LED/StPO, Art. 2(2)(d) GDPR). It does not cover the operator's own database or public pages | GDPR Art. 2(2)(d), 10 |
| Art. 85 GDPR + Art. 38 BayDSG (journalism) | If the processing is "journalistic", most GDPR duties are switched off | Possible only for **edited**, fact-checked campaign write-ups. Not for automated indicator dumps (C-199/24; *Buivids*, C-345/17, "sole object" test; BGH VI ZR 488/19 denied it for a rating portal for lack of own editorial work **[unverified, secondary]**) | §5(g) |

**What practitioners rely on** (all **[unverified]** as to any formal Art. 10 analysis; this is observed practice):

- Abuse desks, blocklists and threat-intel vendors (APWG, Spamhaus, abuse.ch, Shadowserver) rely on Art. 6(1)(f) with Recitals 47/49 and NIS2 Recital 121. They treat indicators as security data, not as offence data.
- Banks rely on statutory duties: the GwG suspicious-activity reports (§ 43 GwG) are Art. 6(1)(c) and fall "under the control of official authority" (FIU). See [criminal-referral-routes.md](criminal-referral-routes.md) §1 of "Follow-the-money".
- Whistleblowers rely on the HinSchG.
- Fraud pools (e.g. SCHUFA FraudPool) have been litigated on Art. 6(1)(f) grounds (OLG Karlsruhe, 14 U 3/19, 23 Feb 2021, listed at https://dejure.org/gesetze/DSGVO/10.html) **[unverified content]**.

**The EDPB's view on systematic reporting** (Guidelines 1/2024 v2.0):

- Para. 128: "the generalised and preventive collection of personal data by private business operators to systematically report possible criminal acts or threats to law enforcement authorities is not what is envisaged by Recital 50".
- Para. 130: following *Meta v Bundeskartellamt* (C-252/21, para. 124), crime-fighting is not a legitimate interest of an operator "whose activity is essentially economic and commercial in nature" where it is unrelated to that activity.
- Para. 131: Art. 6(1)(f) fits where the controller "wishes to report … possible criminal acts or threats it may occasionally become aware of".
- Para. 19: the interest must relate "to the actual activities of the controller".
- Para. 22: interests "of the wider community" belong under Art. 6(1)(c)/(e), not (f).

**Assessment, which cuts both ways:**

- phishing.support is not a commercial operator for which crime-fighting is a side activity. Fighting phishing *is* its actual activity, so para. 19 helps and the *Meta* exclusion does not fit.
- But its collection is systematic and preventive, which is exactly what para. 128 says Recital 50 does not cover.
- The Art. 6(1)(f) basis therefore has to be framed through:
  - the operator's own interest in running an anti-phishing service, protected by freedom of expression and information (Art. 11 Charter);
  - the specific third parties concerned (Art. 4(10), EDPB para. 20): the users who submitted reports and want them acted on, the identifiable victims of the campaign, and the impersonated brands;
  - Recital 49/NIS2 Recital 121 for the security side.
- "The public interest in prosecution" alone will not carry Art. 6(1)(f).

**Conclusion on the gap:**

- There is **no German statute that expressly authorises a private person to collect, store and pass on Art. 10 data for crime fighting.** The law is **unsettled** on whether general norms suffice. The candidates are § 158 StPO for reporting, the DSA for notices, and § 24 BDSG for purpose changes.
- In practice, supervisory authorities have not been seen to object to good-faith criminal complaints. They do fine public accusations (§5(g)).
- **Assessment:** the defensible design keeps Art. 10 data in two places only:
  1. a closed evidence store whose sole purpose is the complaint and the provider notice;
  2. transmissions to the authority or provider that is competent to act on it.

  It also minimises what goes anywhere else.

## 5. Processing steps: legal basis and risk

Each rating below is an **Assessment** of the regulatory and civil exposure for a private operator in Bavaria. It is not a probability of enforcement.

| Step | Legal basis (Art. 6 + Art. 10 + Chapter V) | Main problems | Risk | Key changes |
|---|---|---|---|---|
| **(a) Capturing the site and indicators** (visit, MHTML, screenshots, HAR/data flows with canary values, RDAP/WHOIS, DNS) | Art. 6(1)(f): the operator's anti-phishing activity, the reporters, victims and brands (Recitals 47, 49; NIS2 Recital 121; EDPB 1/2024 paras. 100–104, 125–126). Art. 10: data become offence data once attributed. Basis is § 158 StPO / DSA as the purpose of the capture (§4) | Incidental capture of **victim data** (personalised lure URLs, pre-filled addresses); registrant data of hijacked or identity-theft registrants. Synthetic canary data are not personal data | **Low** | Redact victim identifiers in URLs and MHTML at capture; mark "possibly compromised legitimate site" so it is never treated as a suspect |
| **(b) Storing indefinitely as evidence** | Same as (a), but only as long as necessary | **Indefinite storage violates Art. 5(1)(e).** A growing database of suspicion data about identifiable people edges toward a "comprehensive register" (Art. 10 sentence 2: only under official control) | **Medium** (high if it is the public dataset) | Retention schedule (§6.4); separate the evidence store from the public data; access control and logging (Art. 32; § 22(2) BDSG list as model) |
| **(c) Takedown reports to providers** | EU/EEA: Art. 6(1)(f) (Recitals 47, 49; EDPB para. 104); Art. 10 via **DSA Art. 16** for hosting services (Assessment). Third countries: Art. 45 where the recipient is in an adequate country or is **DPF-certified** (US); otherwise Art. 49(1)(d). The interest in prosecuting and preventing computer fraud is recognised in German law (§ 152 StPO, §§ 263a, 202a ff. StGB) and by the Budapest Convention, to which Germany is a party. An international agreement "can be an indicator" (EDPB 2/2018, p. 10). But (d) may not be used "on a large scale and in a systematic manner" (p. 11) | Reports to Chinese, Russian and other non-adequate providers are repetitive. Art. 49(1)(e) does not fit, because the claims are not the operator's own and it requires a "close link" to a specific procedure (EDPB 2/2018, pp. 11–12). The residual Art. 49(1) second subparagraph requires "not repetitive" and notice to the BayLDA and the data subject | **Low** (EU, adequate, DPF) / **Medium** (other third countries) | Send each provider only its own customer's indicators (URL, IP, timestamps, screenshot), never other providers' data or IBANs/tokens of other services. Record the transfer basis per provider (adequacy/DPF/49(1)(d)). Document the Art. 49(1)(d) assessment once |
| **(d) Strafanzeige and Nachträge to German authorities** | Art. 6(1)(f) + Recital 50. Art. 10 via § 158 StPO; after receipt the data are "under the control of official authority". The EDPB para. 128 caution applies to systematic feeds, so keep each submission case-specific (one campaign = "the same criminal acts") | False-suspicion exposure (§ 164 StGB requires "wider besseres Wissen", so good faith protects; see [multi-country-coordination.md](multi-country-coordination.md) §5.4). Over-inclusion of innocent mules or hijacked-site owners without flagging | **Low** | File "gegen Unbekannt"; flag possible mules, hijacked sites and spoofed senders as "possibly not the perpetrator"; correct the authority when exculpatory facts appear |
| **(e) Annexes meant for foreign authorities, passed via the German authority** | Same as (d). The onward transfer abroad is the **authority's** processing (LED, IRG, Budapest Art. 26, Europol), not phishing.support's | None beyond (d), if the annex contains only what the German complaint contains | **Low** | Label annexes as a suggestion ("Anregung") to the German authority; send nothing to the foreign recipient directly |
| **(f1) Direct complaint to Lithuanian prosecutors** | Same as (d): Art. 6(1)(f) + Recital 50, no Chapter V. Art. 10: German § 158 StPO does not apply to a Lithuanian authority; the Lithuanian equivalent would be the basis **[unverified]** | The same gap as (d), under foreign procedure. Risk of parallel cases without coordination (deconfliction) | **Low–medium** | Only for one-off, big campaigns; tell ZCB about it |
| **(f2) Direct complaint to Turkish prosecutors** | Transfer to a third-country public authority. Türkiye has no adequacy decision (secondary list sources; check the Commission page). Art. 49(1)(d) needs a public interest recognised in EU/German law; Türkiye and Germany are both Budapest Convention Parties (Türkiye in force since 1 Jan 2015, https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185). EDPB 1/2024 para. 136: any disclosure to a third-country authority must also meet Chapter V | A *repeated* feed fails Art. 49 (EDPB 2/2018, pp. 4, 11). Data protection safeguards in the recipient state are unknown. Art. 10 basis abroad is unclear | **High** if repeated; **Medium** for a single documented case | Route through the German authority (Budapest Art. 26 spontaneous information, MLA). If ever done directly: once, minimised, documented Art. 49(1)(d) assessment, lawyer review |
| **(g) Public campaign pages with perpetrator indicators** | Art. 6(1)(f) is possible for **non-personal or low-risk** content (phishing URLs/domains, screenshots with victim data redacted, hoster, kit hashes, timelines). Art. 10: **no basis** for publishing identifiable suspects. Art. 85 / Art. 38 BayDSG only for edited, fact-checked editorial content (C-199/24) | Public bot/webhook **tokens** (secret credentials: anyone can read victims' stolen data or delete the bot's update queue, i.e. evidence). Public **IBANs** (mule account holders named as fraud accounts). Public chat IDs, registrant data, sender addresses. C-439/19 paras. 110–122: disclosure "to any person" is disproportionate where less intrusive means exist (authorities and providers already get the data). C-474/24: individual prior balancing and time limit required. BayLDA: private "Fahndungsaufrufe" are "unrechtmäßig" and fined "in der Regel" (14th TB 2024, ch. 17.1, p. 84, https://www.lda.bayern.de/media/baylda_report_14.pdf); the same report recounts a case where the people publicly accused were innocent. Civil law: identifying suspicion reporting needs a "Mindestbestand an Beweistatsachen", no prejudgment and a hearing of the person (BGH VI ZR 51/99, 7 Dec 1999, https://lexetius.com/1999,317), and a hearing is impossible here | **High** for tokens, IBANs, chat IDs, registrant/sender data. **Medium** for bot usernames/IDs, wallets, collector hosts. **Low** for URLs, domains, screenshots (victim-redacted), hosters, kit hashes, aggregates | Remove tokens and IBANs from public view and from the public ZIP; restrict the full ZIP to the signed authority link; set a publication end date; add an editorial, fact-checked summary if Art. 38 BayDSG is to be claimed |
| **(h) MISP/STIX sharing with authorities and CERTs** | Art. 6(1)(f) with Recital 49 and NIS2 Art. 29/30(1)(b) and Recital 121 (IoC sharing by non-scope entities is expressly envisaged). § 5 BSIG for the BSI. Art. 10: same gap as (d), but to authorities it is under their control once received. Chapter V for non-EU community members (FIRST, CIRCL MISPPRIV are mixed communities) | Onward sharing beyond control; tokens and IBANs reaching non-LE members worldwide | **Low** (authorities/CERTs, TLP:AMBER/RED) / **Medium** (open communities) | Two export profiles: "LE" (full, to named authorities) and "community" (no tokens, no IBANs, no registrant/sender personal data; hashes or bot IDs only); TLP marking |
| **(i) Europol under Art. 26 Europol Regulation** | Art. 6(1)(f) + Recital 50; Europol is an EU body (no Chapter V transfer). Europol must forward the data to national units and **erase** them if none is identified (Art. 26(2), see [multi-country-coordination.md](multi-country-coordination.md) §1.4) | No added value over (d): Europol would forward to the BKA. Duplicates the case | **Low** (legal) / low value | Do not send case data directly; let ZCB/BKA use SIENA. Non-personal research contact (AGRD) is fine |

## 6. Duties that follow

### 6.1 Information duties (Art. 13/14) and data-subject rights

- **Users who submit emails or links: Art. 13.** They are told nothing today. This is a clear breach and the easiest fix (§7).
- **Perpetrators, mules, registrants and other people named in indicators: Art. 14.**
  - **Art. 14(5)(b):** information is not owed where it "is likely to render impossible or seriously impair the achievement of the objectives of that processing". Telling an operator about the referral defeats its purpose, and the contact data are usually unknown.
  - The same provision requires "appropriate measures …, including making the information publicly available". This means a public privacy-policy section.
  - **§ 33(1) No. 2(b) BDSG:** for a non-public body, no information is owed where the competent authority has found disclosure would endanger public security. However, "im Fall der Datenverarbeitung für Zwecke der Strafverfolgung bedarf es keiner Feststellung" (https://www.gesetze-im-internet.de/bdsg_2018/__33.html). This fits the referral purpose directly.
  - **§ 33(2) BDSG:** where information is withheld, provide the Art. 14(1)/(2) information "für die Öffentlichkeit", and "hält schriftlich fest, aus welchen Gründen er von einer Information abgesehen hat".
  - **Art. 14(5)(d)** (professional secrecy) does **not** apply. The operator has no statutory secrecy obligation.
- **Right of access (Art. 15).** § 34(1) No. 1 BDSG excludes access where the person need not be informed under § 33(1) No. 2(b). The reasons must be documented and the refusal reasoned "soweit nicht … der … verfolgte Zweck gefährdet würde" (https://www.gesetze-im-internet.de/bdsg_2018/__34.html).
- **Erasure and objection (Art. 17, 21).**
  - Art. 17(3)(e) (legal claims) does not cover a prosecution that is not the operator's own claim.
  - Defence against objections rests on "compelling legitimate grounds" (Art. 21(1)).
  - **Assessment:** a person who shows they are a mule victim, hijacked-site owner or spoofed sender must be corrected and removed quickly (Art. 16, 17, 21). Build a process for it.
- **Remedies.** After C-199/24, data subjects keep the full GDPR remedies (Art. 77–79, 82), including damages for wrongful publication.

### 6.2 Records of processing (Art. 30)

The under-250-employees exemption does not apply where processing "is not occasional" or "includes … personal data relating to criminal convictions and offences referred to in Article 10" (Art. 30(5)). Both conditions are met, so **records are required**.

Suggested entries:

- intake (user submissions);
- capture and analysis (incl. the OpenAI processor);
- campaign clustering;
- takedown notices;
- criminal referrals and Nachträge;
- public campaign pages;
- threat-intel exports;
- correspondence with providers and authorities.

### 6.3 DPIA (Art. 35) and DPO (§ 38 BDSG, Art. 37)

- **Art. 35(3)(b)** requires a DPIA for "large scale" processing of Art. 10 data. Whether thousands of sites count as large scale is a judgement call.
- **WP248 criteria** (reproduced in the DSK list notes, https://www.lda.bayern.de/media/dsfa_muss_liste_dsk_de.pdf). The following are present:
  - (a) sensitive data (Art. 10);
  - (e) innovative technology (LLM classification);
  - (f) evaluation (phishing verdicts and attribution);
  - (g) matching and combining datasets (campaign clustering);
  - (i) data subjects unable to exercise rights (no Art. 14 notice).

  **Assessment:** two or more criteria are present, so a DPIA is required.
- **The DSK Muss-Liste:**
  - No. 5 (merging data from different sources, incl. "Fraud-Prevention-Systeme") is close.
  - No. 7 ("Veröffentlichung oder Übermittlung" of data used to evaluate behaviour that third parties use for decisions) fits the public pages.
- **DPO:**
  - § 38(1) sentence 2 BDSG: if processing is "einer Datenschutz-Folgenabschätzung … unterliegen", a DPO must be designated "unabhängig von der Anzahl der … Personen" (https://www.gesetze-im-internet.de/bdsg_2018/__38.html).
  - Art. 37(1)(c) independently requires one where core activities are large-scale processing of Art. 10 data.
  - **Consequence:** a DPO is very likely mandatory. An external DPO is allowed, but the operator cannot be his own DPO, because of the conflict of interest (Art. 38(6)).

### 6.4 Retention

There is no statutory period for a private reporter. **Assessment:** derive one from the purposes.

| Data | Purpose | Suggested limit (Assessment) |
|---|---|---|
| Captures of sites never linked to a referral | Takedown, clustering of future sites | 12–24 months after the last activity of the cluster |
| Evidence of referred campaigns (capture files, manifests, timestamps) | Prosecution | Until the authority reports closure; while an investigation could still reopen, at most until prosecution of the offence is time-barred. That is 5 years for § 263a(1) StGB (maximum 5 years → § 78(3) No. 4 StGB) and 10 years for gang or commercial fraud under § 263(5) (1–10 years → § 78(3) No. 3), counted from the last site |
| Public campaign page indicators | Warning the public, transparency of takedowns | Personal-data indicators off once the campaign is inactive and taken down (e.g. 90 days after the last site). By analogy to C-474/24, publication beyond the purpose's duration "is disproportionate". Non-personal aggregates may stay |
| User submissions (emails) | Analysis, takedown, evidence | Like the captures; redacted public version as long as it is useful |
| Correspondence with providers and authorities | Proof of reporting | Like the campaign evidence |

### 6.5 Security (Art. 32)

- Bot and webhook tokens are live credentials to systems that hold victims' stolen data. Store them encrypted, restrict access and **never publish them**.
- **The operator must never use them.** Calling `getMe` or `getUpdates` is § 202a StGB exposure ([criminal-referral-routes.md](criminal-referral-routes.md), follow-the-money §4).

### 6.6 Victims' and brands' data in captured pages

- **Victims:** personalised lure URLs, pre-filled e-mail addresses and victims' data seen in exfiltration traffic are personal data of victims. They are not Art. 10 data.
  - Redact them in everything public.
  - Pass them to authorities only where needed for the case.
  - Never pass them to providers outside the provider's own context.
  - The existing recipient redaction in [mail_ai.ts](/Users/user/Developer/Developer/ai/phishing_reporter/src/lib/mail_ai.ts:122) should be applied to MHTML and screenshots too. **Assessment:** the public evidence ZIP serves MHTML files, which may contain such data as captured.
- **Brands:** logos and trademarks raise no GDPR issue. Brand employees named on cloned pages (rare) are personal data. Treat them like victims.

## 7. The existing privacy text, judged

- **What exists:** one sentence in [About.tsx](/Users/user/Developer/Developer/ai/phishing_reporter/src/components/About.tsx:47), "Only submit emails or links you're allowed to share publicly."
- **What is missing:**
  - controller identity and contact;
  - purposes and legal bases;
  - recipients (providers worldwide, authorities, OpenAI, hosting);
  - transfers and their bases;
  - retention;
  - rights;
  - the right to complain to the BayLDA;
  - the § 33(2) BDSG public information for people named in indicators.
- **Imprint:** there is no Impressum. § 18(1) MStV requires name and address from every telemedia provider not "ausschließlich persönlichen oder familiären Zwecken" (Landesmedienanstalten FAQs, e.g. https://medienanstalt-mv.de/aktuelles/news/7721-impressumspflicht-in-telemedien.html). § 5 DDG applies only to "geschäftsmäßige, in der Regel gegen Entgelt angebotene" services (https://www.gesetze-im-internet.de/ddg/__5.html), which a donation-funded site may arguably fall outside. **Assessment:** the MStV duty applies regardless. This is out of the data-protection scope, but it is a gap.
- **Verdict:** the current text satisfies none of Art. 12–14 GDPR. It also puts the burden on the user ("allowed to share publicly"), although the service itself decides what is published.

## 8. Recommendations

### 8.1 Product changes (ordered by risk reduction)

1. **Stop publishing secrets and accusations.**
   - Remove from [public_view.ts](/Users/user/Developer/Developer/ai/phishing_reporter/src/lib/campaign/public_view.ts:118) and the public page: bot tokens, webhook tokens, chat IDs, server and channel IDs, IBANs, registrant personal data and sender addresses.
   - Publicly, show at most: the platform ("Telegram bot", "Discord webhook", "IBAN at a German bank"), a non-reversible short hash for linking, and the count of sites.
   - Wallets: show them only where the wallet is already flagged in a public abuse database, or not at all.
2. **Make the full evidence ZIP non-public.**
   - Serve [evidence.zip](/Users/user/Developer/Developer/ai/phishing_reporter/src/app/campaigns/[id]/evidence.zip/route.ts:1) only through the existing signed, expiring download link that authorities get ([download_link.ts](/Users/user/Developer/Developer/ai/phishing_reporter/src/lib/referral/download_link.ts:46)).
   - If a public archive is wanted, build a separate "public" ZIP: screenshots with victim data redacted, URLs, hosts, hashes, manifest; no MHTML, no tokens, no IBANs.
3. **Introduce data tiers in code:**
   - `public` (non-personal and low-risk);
   - `provider` (only that provider's own customer's indicators);
   - `authority` (everything relevant to the case);
   - `community-intel` (IoCs without tokens or personal identifiers, TLP-marked).

   One function decides the tier per indicator kind, so every channel uses it (in place of today's single dossier for all audiences).
4. **Flag possible innocents.** Mark these as "possibly not the perpetrator" in every output and keep them off public pages:
   - IBAN holders (likely mules);
   - hijacked legitimate domains (old registration date, unrelated content);
   - sender addresses;
   - registrants.
5. **Retention jobs** per §6.4, with an automatic "unpublish personal indicators" step after the campaign ends.
6. **Per-recipient transfer basis.** For each provider and authority, record the country and the transfer basis (EU, adequacy, DPF certification, Art. 49(1)(d)), and refuse to send to a non-EU authority directly.
7. **Upstream hold rule** (see [multi-country-coordination.md](multi-country-coordination.md) §5.1). It also serves data protection: fewer recipients of exfiltration identifiers.
8. **Redact victim identifiers in captures** (lure URL parameters, pre-filled fields) before anything leaves the evidence store.
9. **Robots:** consider `noindex` for campaign pages until they contain only `public`-tier data, because search-engine reach increases the interference (C-136/17).

### 8.2 Documentation to create

- Records of processing (Art. 30), one entry per step in §5.
- A legitimate-interest assessment per step (EDPB 1/2024 three-step test), naming the specific third parties (reporters, victims, brands) and the operator's activity. Do not rely on the "public interest".
- A DPIA covering clustering, referrals, publication and transfers.
- The § 33(2) BDSG note on why perpetrators are not informed individually.
- A one-page Art. 49(1)(d) assessment for takedown reports to non-adequate countries.
- Designate an external DPO (§ 38(1) sentence 2 BDSG).

### 8.3 Privacy policy text to add (draft)

A starting text in English is below; publish a German version too. Fill the brackets. This is a draft for a lawyer or DPO to check, not final wording.

> **Privacy policy – phishing.support**
>
> **Controller.** Samuel Scheit, [postal address], [e-mail]. Data protection officer: [name/contact].
>
> **What we do.** phishing.support analyses phishing e-mails and websites, reports them to the companies that host or register them so they are taken down, and reports phishing campaigns to law enforcement, mainly the Zentralstelle Cybercrime Bayern. We publish information about phishing campaigns to warn the public.
>
> **1. If you submit an e-mail or link.** We process the submitted e-mail (headers, content, attachments) or link and, if you send by e-mail, your sender address. Purpose: analysing the phishing attempt, reporting it for takedown and prosecution. Legal basis: Art. 6(1)(f) GDPR (our interest and yours in having the phishing attempt stopped and prosecuted). We remove recipient addresses before anything is published. Recipients: hosting providers, registrars and other providers responsible for the phishing site (also outside the EU, see 5); law enforcement authorities; OpenAI [entity, country] as processor for automated analysis; [hosting provider] as processor. Retention: [period].
>
> **2. Data about people behind phishing sites.** To report phishing we collect from the phishing sites themselves and from public registries: domain and registration data, IP addresses, the accounts and channels to which the sites send stolen data (e.g. messenger bots, webhooks), payment details shown on the sites (e.g. IBANs, crypto addresses), sender addresses and similar identifiers. Some of this data may relate to criminal offences (Art. 10 GDPR). Purpose: takedown of the sites, prevention of further fraud, and enabling prosecution. Legal basis: Art. 6(1)(f) GDPR in conjunction with § 158 StPO (criminal complaints) and Art. 16 Regulation (EU) 2022/2065 (notices of illegal content). Recipients: the providers concerned (each only its own customer's data), German law enforcement authorities, and, through them, foreign authorities. We do not publish payment details, access tokens or personal registration data. Some of these identifiers may belong to people who are themselves victims (e.g. account holders misused as money mules, owners of hacked websites); we mark such cases and correct or delete data when we learn of it.
>
> **Why we do not inform these people individually.** Informing them would defeat the purpose of the processing, the prevention and prosecution of crime (Art. 14(5)(b) GDPR, § 33(1) No. 2(b) BDSG). This notice is the public information under § 33(2) BDSG.
>
> **3. Public campaign pages.** We publish the addresses of phishing pages, screenshots (with victims' data removed), the providers involved and how the pages are linked. We remove [identifiers/categories] [N days] after a campaign has ended.
>
> **4. Visitors of this website.** [Server logs, cookies/none, TDDDG § 25 statement, hosting provider.]
>
> **5. Transfers outside the EU.** Providers of phishing sites are often outside the EU. Where the recipient is in a country with an EU adequacy decision or certified under the EU-U.S. Data Privacy Framework, the transfer is based on Art. 45 GDPR. Otherwise we transfer only the data the provider needs to remove its customer's phishing site, based on Art. 49(1)(d) GDPR (important reasons of public interest in preventing and prosecuting computer fraud recognised in German law). We do not send data directly to law enforcement authorities outside the EU.
>
> **6. Retention.** [Table from §6.4.]
>
> **7. Your rights.** Access (Art. 15), rectification (Art. 16), erasure (Art. 17), restriction (Art. 18), objection (Art. 21), subject to the limits in §§ 33–34 BDSG where prosecution would be endangered. If you believe we have wrongly listed you, e.g. as owner of a misused account or a hacked website, contact [e-mail]; we will check and correct promptly. You can complain to the Bayerisches Landesamt für Datenschutzaufsicht, Promenade 18, 91522 Ansbach [verify address].

### 8.4 Lawyer: when and for what

Involve a data-protection lawyer (or the external DPO) **before** filing the first automated Nachträge and before any foreign direct complaint, for these specific questions:

1. **Art. 10 basis.** Does § 158 StPO (or § 24(1) No. 1 BDSG) count as Member State law "authorising" Art. 10 processing by a private complainant, including a standing evidence store kept for repeated complaints? Could the BayLDA be asked informally for its position (Art. 57(1)(e))?
2. **Systematic reporting after EDPB 1/2024 paras. 128–131.** Can a non-profit whose *only* activity is anti-phishing rely on Art. 6(1)(f) for systematic referrals? Or is an agreement with ZCB needed? For example, a request from the authority to receive Nachträge, which would bring the feed closer to "under the control of official authority".
3. **Public pages.** Which indicator kinds, if any, may be published under Art. 6(1)(f) or Art. 38 BayDSG? Would an editorial, fact-checked campaign report qualify as journalism after C-199/24?
4. **Third-country transfers.** Does Art. 49(1)(d) hold for repetitive takedown reports to non-adequate countries (China, Russia, Türkiye)? Or is there a better route, such as relying on the provider's EU representative under Art. 13 DSA?
5. **DPO and DPIA.** Confirm that both are required, and scope the DPIA.
6. **Civil liability.** Assess exposure under §§ 823, 1004 BGB analogously for wrongly attributed mules, hijacked sites and spoofed senders, and an appropriate correction procedure.

## Open questions

1. When will the EDPB adopt its Art. 64(2) Opinion on the scope of Art. 10 (Guidelines 1/2024 v2.0, fn. 63), and who requested it? Check the opinions register: https://www.edpb.europa.eu/our-work-tools/our-documents/opinion-board-art-64_en.
2. Full text of C-474/24 and C-199/24. Only the press releases were read; the reasoning on Art. 10 and on individual balancing should be read in full.
3. Commentaries (Kühling/Buchner, Gola/Heckmann, Simitis/Hornung/Spiecker, BeckOK) on Art. 10 and Verdachtsdaten, and on § 24 BDSG as an Art. 10 authorisation. They were only quoted second-hand here.
4. Which providers phishing.support reports to are DPF-certified (check https://www.dataprivacyframework.gov/list per provider). Is OpenAI's contracting entity DPF-certified, or under SCCs?
5. Exact text of DSA Art. 16(2) and whether registrars and CDNs (not "hosting") fall under Art. 16. Only secondary copies were read.
6. Whether a BayLDA or DSK publication exists on private threat-intelligence or abuse-reporting services. None was found in the 14th/15th BayLDA activity reports apart from the "Fahndungsaufruf" fines.
7. The current Commission adequacy list (secondary sources disagree on Brazil; Türkiye is not on it): https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en.

## Sources (primary unless marked)

- GDPR (EUR-Lex): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679
- BDSG §§ 1, 2, 22, 33, 34, 38: https://www.gesetze-im-internet.de/bdsg_2018/; § 24: https://dejure.org/gesetze/BDSG/24.html
- BayDSG Art. 18, 38: https://www.gesetze-bayern.de/Content/Document/BayDSG-18, https://www.gesetze-bayern.de/Content/Document/BayDSG-38
- StPO § 158: https://dejure.org/gesetze/StPO/158.html; StGB §§ 78, 138, 263, 263a: https://www.gesetze-im-internet.de/stgb/
- DDG § 5: https://www.gesetze-im-internet.de/ddg/__5.html
- NIS2 Directive (EUR-Lex): https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A32022L2555
- CJEU C-439/19: https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62019CJ0439
- CJEU C-136/17: https://www.dpcuria.eu/case?reference=C-136%2F17 (summary mirror of the judgment)
- CJEU C-740/22: https://ipcuria.eu/case?reference=C-740/22
- CJEU C-474/24 press release: https://curia.europa.eu/site/upload/docs/application/pdf/2026-07/cp260103en.pdf
- CJEU C-199/24 press release: https://curia.europa.eu/site/upload/docs/application/pdf/2026-07/cp260100de.pdf
- CJEU C-582/14 *Breyer*: https://ipcuria.eu/case?reference=C-582%2F14; C-212/13 *Ryneš*: https://www.dpcuria.eu/case?reference=C-212%2F13; C-345/17 *Buivids*: https://www.dpcuria.eu/case?reference=C-345%2F17
- EDPB Guidelines 1/2024 v2.0 (10 Nov 2026): https://www.edpb.europa.eu/system/files/2026-11/edpb_guidelines_202401_legitimateinterest_v2_en.pdf
- EDPB Guidelines 2/2018 on Art. 49: https://gr.andersenlegal.com/wp-content/uploads/2018/07/edpb_guidelines_2_2018_derogations_en.pdf (copy of the EDPB PDF)
- DSK DSFA-Muss-Liste v1.1: https://www.lda.bayern.de/media/dsfa_muss_liste_dsk_de.pdf
- BayLDA 14th activity report 2024 (ch. 17.1): https://www.lda.bayern.de/media/baylda_report_14.pdf; 15th report 2025: https://www.lda.bayern.de/media/baylda_report_15.pdf
- BGH VI ZR 51/99: https://lexetius.com/1999,317
- Secondary: datenschutz-notizen.de (commentary quotes), datenschutzstelle.li, datenschutzdigital.de, gdprhub.eu, Landesmedienanstalten FAQs, Council of Europe treaty chart.
