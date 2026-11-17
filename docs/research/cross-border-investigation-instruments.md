# Cross-border instruments: getting the infrastructure countries to investigate

Date: 2026-11-17

Question: phishing.support wants investigations opened **in the countries where the infrastructure sits** (hoster, CDN, registrar, exfiltration endpoint). Local police there would obtain subscriber, payment and log data with their own court orders, so Germany does not have to run slow mutual legal assistance (MLA). The national proceedings must then be coordinated so the investigation continues. Which legal and institutional instruments make this possible as of November 2026, and how would a German authority (for example ZCB Bamberg) use them?

This report builds on [criminal-referral-routes.md](criminal-referral-routes.md) and [first-contact-zcb.md](../referral/first-contact-zcb.md). It does not repeat their findings on intake routes, provider preservation practice or the German Quick-Freeze bill.

Method: each claim cites the page it was checked against. Primary sources are the CoE treaty office, EUR-Lex, gesetze-im-internet.de, gesetze-bayern.de (RiVASt), verwaltungsvorschriften-im-internet.de (RiVASt Länderteil), dserver.bundestag.de, the Commission, Eurojust, Europol, BKA, politie.nl and the UN Treaty Collection. **[unverified]** marks claims taken only from secondary sources or not confirmed on a primary page. Some EUR-Lex texts (Reg. 2023/1543, FD 2009/948, the EU MLA Convention) could not be fetched in full; their content is cited through the German government bill, the Official Journal PDF copy or Commission documents, as noted.

---

## Summary: the ten most important findings

1. **No instrument makes another state open proceedings.** Every route is a request or a piece of information, and the receiving state decides under its own law. The 1959 Convention's Art. 21 only requires it to say what it did with the information ([jus.uio.no copy of CETS 030](https://www.jus.uio.no/english/services/library/treaties/04/4-07/eur_ass_criminal.html)).
2. **Germany's tool for this is the "Anzeige zum Zwecke der Strafverfolgung" (RiVASt Nr. 145–147).** For the Netherlands and Lithuania it goes **directly between judicial authorities**. For the US it goes through the Bundesamt für Justiz to the US Department of Justice ([RiVASt Länderteil](https://www.verwaltungsvorschriften-im-internet.de/bsvwvbund_01012017_IIB6935088.htm)). The German case **stays open** unless a treaty says otherwise (RiVASt Nr. 146 (4), [gesetze-bayern.de](https://www.gesetze-bayern.de/Content/Document/RiVASt-NN161)). Parallel proceedings are therefore the default, not a transfer.
3. **The EU Transfer Regulation 2024/3011 applies from 1 February 2027.** Germany's implementing provisions (§§ 320–326 IRG-E) were cleared by the Bundestag legal committee on 11.11.2026 and are scheduled for the same date ([BT-Drs. 21/7558](https://dserver.bundestag.de/btd/21/075/2107558.pdf), [21/9144](https://dserver.bundestag.de/btd/21/091/2109144.pdf)). The Regulation lists "most relevant evidence located in the requested State" as a reason to transfer. But a state where **no part of the offence, effects or damage** occurred and where the suspect is neither national nor resident may refuse (Art. 12(2)(c), [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/3011/oj/eng)). A pure hosting country is the weakest case.
4. **Coordination after that is a JIT.** A joint investigation team lets each member state collect data under its own law and hand it to the others **directly** (§ 93 IRG for EU states, § 61b IRG for others, [gesetze-im-internet.de](https://www.gesetze-im-internet.de/irg/__93.html)). Eurojust drafts, coordinates and funds JITs, including with non-EU states (up to EUR 50,000 per standard application; urgent applications up to EUR 8,000 at any time, [Eurojust JIT funding FAQ](https://www.eurojust.europa.eu/judicial-cooperation/instruments/joint-investigation-teams/jits-funding/jits-funding-faq)). This is the instrument that matches the operator's goal most closely.
5. **Only national judicial authorities can open a case at Eurojust,** through their National Desk. Third states can do so if they have a Liaison Prosecutor there; the US, UK, Ukraine and Switzerland do ([Eurojust life cycle](https://www.eurojust.europa.eu/judicial-cooperation/tasks-and-tools/life-cycle-case), [liaison prosecutors](https://www.eurojust.europa.eu/states-and-partners/third-countries/liaison-prosecutors)). A private service cannot trigger it; ZCB can.
6. **Europol may take personal data directly from private parties,** but only to find the "national units concerned", and must then forward it to them "for the purpose of establishing jurisdiction" (Europol Regulation Art. 26(2) as amended by Reg. 2022/991, [Europol copy](https://www.europol.europa.eu/cms/sites/default/files/documents/CELEX_32022R0991_EN_TXT.pdf)). That is legally the closest thing to a private multi-country referral. A public submission channel is **[unverified]**.
7. **German prosecutors can issue European Production Orders (EPOC) but not European Preservation Orders (EPOC-PR).** The Commission's readiness table of 6 November 2026 lists Germany as ready to issue EPOCs only. Hungary, Italy, Slovakia and Sweden are listed for "EPOCs and EPOC-PRs" ([Commission readiness PDF](https://commission.europa.eu/document/download/5b3c2ee0-4055-4694-82c3-dc265cd6f108_en?filename=Information%20on%20Member%20States%20ready%20to%20issue%20and%20or%20receive%20EPOCs%20and%20EPOCS-PR.pdf)). This corrects the earlier report: the German route to fast preservation remains the Budapest 24/7 point at the BKA.
8. **Only seven member states appear in that readiness table.** The Netherlands and Lithuania are not among them (same PDF). Where the IT system is unavailable, the Commission lets orders go by secure e-mail and other alternative means ([contingency guidance](https://commission.europa.eu/document/download/1a0a704c-42b5-4ed0-a440-e4227eb0ec40_en?filename=Commission%20Guidance%20on%20contingency%20arrangements.pdf)).
9. **The Second Additional Protocol to the Budapest Convention (CETS 224) is not in force.** Four of the five required ratifications exist (Serbia, Japan, Hungary, Costa Rica). Germany, the USA, Lithuania and the Netherlands have only signed ([CoE treaty office](https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224)). Direct registrar and provider requests (Art. 6/7) are therefore not available. There is no EU–US e-evidence agreement ([DOJ CLOUD Act resources](https://www.justice.gov/criminal/cloud-act-resources)). The UN Cybercrime Convention has 96 signatories (Germany 1 Jun 2026) and only 3 parties ([UNTC](https://treaties.un.org/Pages/ViewDetails.aspx?src=IND&mtdsg_no=XVIII-16&chapter=18&clang=_en)).
10. **Real phishing cases show the pattern but not a clean "hoster country opened its own case" story.** Tycoon2FA began with a Trend Micro tip to Europol; police in LV, LT, PT, PL, ES and the UK then took measures ([Europol, 4 Mar 2026](https://www.europol.europa.eu/media-press/newsroom/news/global-phishing-service-platform-taken-down-in-coordinated-public-private-action)). Kratos was a ZIT/BKA case with the US, and Indonesia arrested the developer ([BKA](https://www.bka.de/SharedDocs/Kurzmeldungen/DE/Kurzmeldungen/260720_Schlag_gegen_Phishing_Gruppierung_Kratos.html)). The Eurojust proxy case shows the alternative: lead countries sent requests to the countries where the servers stood ([Eurojust, 12 Mar 2026](https://www.eurojust.europa.eu/news/servers-used-cybercrime-around-world-taken-down)). What triggers police action is one dossier per actor sent through a national authority or Europol, not individual site reports.

---

## 1. Asking a foreign state to open its own proceedings

### 1.1 Art. 21 European Convention on Mutual Assistance 1959 (CETS 030): "laying of information"

**What it does.** Art. 21 (1): "Information laid by one Contracting Party with a view to proceedings in the courts of another Party shall be transmitted between the Ministries of Justice concerned …". Art. 21 (2): "The requested Party shall notify the requesting Party of any action taken on such information and shall forward a copy of the record of any verdict pronounced." ([jus.uio.no copy](https://www.jus.uio.no/english/services/library/treaties/04/4-07/eur_ass_criminal.html))

- In force since 12/06/1962 ([CoE treaty office](https://www.coe.int/en/web/conventions/full-list?module=treaty-detail&treatynum=030)).
- The Third Additional Protocol replaces paragraph 1 and routes the information under Art. 15 (1) and (8) ([search summary of rm.coe.int/48801f9d31](https://rm.coe.int/48801f9d31)) **[unverified]**.
- Between EU states, the 2000 EU MLA Convention (Art. 6 (1)) lets Art. 21 information go directly between judicial authorities. This is confirmed in practice by the RiVASt Länderteil (1.2 below). The EUR-Lex text could not be fetched; the House of Lords summary says the same ([publications.parliament.uk](https://publications.parliament.uk/pa/ld199900/ldselect/ldeucom/93/9308.htm)).

**Who can trigger it.** The state, which in Germany means the Staatsanwaltschaft or the Justizverwaltung. A private person cannot.

**Time to effect.** No deadline. The only duty is to report back.

**Limits.**

- There is no duty to prosecute. The receiving state applies its own jurisdiction rules and its own legality or opportunity principle.
- The receiving state must be able to treat the act as committed on its territory or otherwise within its jurisdiction.
- Budapest Convention Art. 22 (1)(a) obliges every party to establish jurisdiction over offences "committed in its territory". The Explanatory Report (para. 233) gives as an example the case "where the computer system attacked is within its territory", even if the attacker is not ([worldlii copy of the Explanatory Report](https://www.worldlii.org/int/other/COETSER/2001/8.html)). Whether hosting a phishing page or a collector server is a territorial act in a given country is a question of that country's law **[unverified per country]**.

### 1.2 German practice: Anzeige zum Zwecke der Strafverfolgung / Verfolgungsersuchen (RiVASt Nr. 145–147)

**What it does.**

- **RiVASt Nr. 145 (1):** if a person prosecuted in Germany, for an offence where extradition is not an option, is abroad, "hat die Verfolgungsbehörde zu prüfen, ob der ausländische Staat um Verfolgung ersucht werden soll", subject to proportionality ([gesetze-bayern.de Nr. 145](https://www.gesetze-bayern.de/Content/Document/RiVASt-NN160)). The rule assumes a suspect located abroad. Infrastructure-only cases are not mentioned, but the same form is used in practice. This is my reading, not a quoted source.
- **RiVASt Nr. 146:** form and content ([gesetze-bayern.de Nr. 146](https://www.gesetze-bayern.de/Content/Document/RiVASt-NN161)):
  - a report to the supreme justice authority (Muster 34), unless the direct channel is allowed (then Muster 34a);
  - a Sachverhaltsdarstellung (Muster 35) with the suspect's identity and nationality, the results of the investigation so far and the measures taken;
  - two copies of a translation;
  - ideally a copy of the file, "um einem ausländischen Rechtshilfeersuchen zuvorzukommen".
- **Nr. 146 (3) S. 4:** "Die auf den Fall anwendbaren deutschen Bestimmungen sind im Wortlaut wiederzugeben."
- **Nr. 146 (4):** "Ein Ersuchen um Verfolgung hindert die weitere Verfolgung im Hoheitsgebiet der Bundesrepublik Deutschland nur, wenn und soweit dies in einer völkerrechtlichen Übereinkunft bestimmt ist." The German case can stay open in parallel.

**Channels by country** (RiVASt Länderteil, [verwaltungsvorschriften-im-internet.de](https://www.verwaltungsvorschriften-im-internet.de/bsvwvbund_01012017_IIB6935088.htm)):

| Country | Channel for "Anzeigen zum Zwecke der Strafverfolgung" | Länderteil status |
|---|---|---|
| Netherlands | "unmittelbar zwischen den zuständigen Justizbehörden beider Staaten" | Juli 2012 |
| Lithuania | same, directly between judicial authorities | März 2017 |
| Belgium, Bulgaria, Estonia, Finland, Denmark (MLA) | directly between judicial authorities | various |
| France | Bundesamt für Justiz ↔ French Ministry of Justice | — |
| USA | Bundesamt für Justiz ↔ US Department of Justice; in urgent cases via the Landesjustizverwaltungen | September 2023 |
| UK (England, Wales, NI) | directly to the UK Central Authority (Home Office) | März 2015 |
| Ukraine | MLA via BfJ/Landesjustizverwaltung ↔ Ministry of Justice / Prosecutor General | März 2017 |

**IRG basis today.** The current IRG has no section on outgoing transfer of proceedings ([IRG table of contents](https://www.gesetze-im-internet.de/irg/)). Germany may drop acts committed abroad under § 153c (1) Nr. 1 StPO ([gesetze-im-internet.de](https://www.gesetze-im-internet.de/stpo/__153c.html)). Under § 9 (1) StGB an act is committed wherever the offender acted or where the result occurred ([gesetze-im-internet.de](https://www.gesetze-im-internet.de/stgb/__9.html)). German victims or German brands therefore usually give Germany jurisdiction too.

**IRG reform.** The government bill [BT-Drs. 21/7558](https://dserver.bundestag.de/btd/21/075/2107558.pdf) of 12.08.2026 introduces "erstmals ausdrückliche Regelungen zur polizeilichen Rechtshilfe und zur Übertragung der Strafverfolgung":

- **§§ 137–140 IRG-E (all states):**
  - § 138 requires a written request with a Sachverhaltsdarstellung and a copy of the file.
  - § 140 (1): "Wurde eine ausländische Behörde um Übernahme der Strafverfolgung ersucht, so kann das Verfahren vorläufig eingestellt werden."
  - § 140 (2): German investigations can resume if further measures are needed or the case is not taken over in reasonable time.
- **§§ 320–326 IRG-E** implement Reg. 2024/3011 and enter into force on 1 February 2027 (Art. 24).
- **Status:** the legal committee recommended adoption with amendments on 11.11.2026 ([BT-Drs. 21/9144](https://dserver.bundestag.de/btd/21/091/2109144.pdf)). The plenary vote and promulgation are **[unverified]**.

**Who can trigger it.** The Staatsanwaltschaft. A private complainant can only suggest it.

**Time to effect.** No deadline. The time depends on translation and the channel. Direct judicial channels inside the EU avoid the ministry step.

**Can it target a pure hosting country?** Legally nothing forbids sending an Anzeige to a state whose only link is a server. Whether that state acts depends on:

- **Jurisdiction:** whether hosting the page or receiving the stolen credentials counts as an act on its territory. For the Netherlands, Lithuania and the US this is **[unverified]**.
- **Prosecution policy:** the Netherlands applies the opportunity principle; whether Lithuania applies a legality principle is **[unverified]**.
- **Local victims or brands:** the hosting state is not required to have any, but they raise priority.

The strongest case for the hosting state exists when the hoster itself is complicit (bulletproof hosting), because the offence is then plainly committed there. The Dutch cases in section 6 show this.

### 1.3 European Convention on the Transfer of Proceedings 1972 (CETS 073)

- In force since 30/03/1978 with 25 parties, including the Netherlands (since 1985) and Lithuania (since 2000). **Germany has neither signed nor ratified** ([CoE treaty office](https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=073)).
- So a German authority cannot use it, and Reg. 2024/3011 replaces it within the EU from 1 February 2027 (Art. 33 (1), [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/3011/oj/eng)).

### 1.4 Regulation (EU) 2024/3011 on the transfer of proceedings in criminal matters

Source for this section: [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/3011/oj/eng).

**Dates.**

- In force since 7 January 2025 (20 days after publication on 18.12.2024).
- "It shall apply from 1 February 2027" (Art. 36).
- Communication through the decentralised IT system (Art. 24) only becomes mandatory two years after the implementing acts under Art. 25. Until then "any appropriate alternative means" (Art. 35).
- Denmark does not take part (recital 73). Ireland notified its wish to take part (recital 72).

**What it changes.**

- **Who requests:** a binding EU procedure. A judge, court or prosecutor issues the request; other investigating authorities need validation (Art. 2 (3)).
- **Who may propose:** the suspect and the victim may propose a transfer, without creating an obligation (Art. 5 (3)). **A third-party reporter is not mentioned.**
- **Criteria (Art. 5 (2)):**
  - (a) offence committed wholly or partly in the requested state, or most effects or substantial damage there;
  - (e) most relevant evidence or witnesses there;
  - (f)/(g) ongoing proceedings there against the same or other persons for the same or related facts;
  - (j) victims who are nationals or residents there;
  - (k) consensus under FD 2009/948.
- **Jurisdiction:** the requested state gets jurisdiction it would otherwise lack (Art. 3 (1)), but only in five listed cases. One is "most effects or a substantial part of the damage" on its territory (c). Another is ongoing proceedings there against others for the same facts where the person is a national or resident (e). **Evidence location alone does not create jurisdiction.**
- **Deadlines:** decision on acceptance within 60 days, extendable once by up to 30 days (Art. 13).
- **Grounds for refusal (Art. 12):**
  - mandatory: not an offence in the requested state, ne bis in idem, time-bar, no jurisdiction, among others;
  - optional (12 (2)(c)): "no part of the offence, effects, or damage occurred in the requested State, and the suspect is neither a national nor a resident there". **This is exactly the pure-hosting case.**
- **Effect:** on acceptance, the requesting state suspends or discontinues. Urgent and freezing measures may continue (Art. 21).
- **German implementation:** §§ 320–326 IRG-E from 1 February 2027. The prosecutor decides on incoming requests; local competence follows the existing case or the Gerichtsstand ([BT-Drs. 21/7558](https://dserver.bundestag.de/btd/21/075/2107558.pdf)).

**Fit for the operator's goal.** A transfer gives the case away. That is useful when the suspects are clearly in the requested state, for example when the Netherlands already investigates a Dutch bulletproof hoster. It does not fit the goal "each country collects locally, Germany keeps coordinating". For that, parallel proceedings plus a JIT (4.3) fit better. Art. 5 (2)(f)/(g) also show the order of steps: once the hosting state has its **own** case on the same facts, a later transfer or concentration becomes easy.

### How phishing.support can make section 1 easier for ZCB

The dossier should be cut into **one "country slice" per infrastructure country**, ready to become the RiVASt Muster 35 Sachverhaltsdarstellung:

- **Infrastructure in that country, per item:**
  - URL, domain, IP, ASN;
  - the hoster's legal name and registered seat;
  - the customer, account or project identifiers visible from outside (for example the `*.onrender.com` subdomain);
  - the exact UTC timestamps first and last seen;
  - the response that proves the site was live;
  - the evidence hash and RFC 3161 token.
- **What that country's police can obtain domestically:** which data the provider holds (account, payment, login IPs), retention known from section 4 of the earlier report, and the provider's law-enforcement contact.
- **Links to that country:** victims, brands, payment receivers, exfiltration endpoints located there. Even one local victim or brand helps against the Art. 12 (2)(c) refusal ground.
- **The German provisions in full text** (RiVASt Nr. 146 (3)): §§ 263a, 269, 202a/202c, 152a StGB, § 143 MarkenG as applicable, with an English translation. The BMJ publishes official English translations of the StGB on gesetze-im-internet.de **[unverified that they are current]**.
- **An English summary of 1–2 pages** plus annex tables in CSV. This cuts the translation cost that otherwise delays everything.
- **A list of other known proceedings and reports** per country (NCSC-UK, IC3, provider abuse tickets, any case numbers). This feeds Art. 5 (2)(f)/(g) of the Regulation and FD 2009/948.

---

## 2. Spontaneous information without a request

| Instrument | Who may send | To whom | Conditions | Source |
|---|---|---|---|---|
| Budapest Convention Art. 26 | any Party | any Party | within domestic law; may attach confidentiality or use conditions; meant for information that may help the receiver initiate or carry out investigations or proceedings | text: [rm.coe.int/1680081561](https://rm.coe.int/1680081561) (page behind a bot challenge; wording confirmed by search snippet); T-CY Guidance Note on Spontaneous Information adopted 25 June 2025 ([coe.int](https://www.coe.int/en/web/cybercrime/-/the-t-cy-adopts-a-new-guidance-note-on-spontaneous-information-)) |
| EU MLA Convention 2000 Art. 7 | competent authorities of EU states | competent authorities of EU states | "Within the limits of their national law … may exchange information, without a request to that effect, relating to criminal offences" within the receiver's competence; directly between judicial authorities (Art. 6) | [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A42000A0712%2801%29) (text via search snippet; Council explanatory report [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=oj:JOC_2000_379_R_0007_01)) |
| § 61a IRG | Gerichte, Staatsanwaltschaften | public bodies of other states and international bodies | allowed if sending to a German prosecutor would be lawful, and if needed to prepare an MLA request for an offence carrying a maximum of **more than 5 years** (or one "von erheblicher Bedeutung" where data protection is adequate), or to avert danger; with conditions on deletion and purpose limitation | [gesetze-im-internet.de](https://www.gesetze-im-internet.de/irg/__61a.html) |
| Directive (EU) 2023/977 / §§ 92d, 92e IRG | Polizei-, Finanz-, Zollbehörden | law-enforcement authorities or Single Point of Contact (SPOC) of EU states | § 92d: **may** send available information on its own initiative where there are objective indications it could be relevant. § 92e: **must** send self-collected information relevant to "schwere Straftaten" (Art. 2 (3) Directive). Copy to the SPOCs (§ 92c) | [§ 92d](https://www.gesetze-im-internet.de/irg/__92d.html), [§ 92e](https://www.gesetze-im-internet.de/irg/__92e.html) |

- Directive 2023/977 replaced Framework Decision 2006/960/JHA from 12 December 2024. The Directive makes **SIENA** the mandatory channel (Art. 13), with a later deadline for Art. 13 of 12 June 2027 ([EUR-Lex PDF via search](https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32023L0977)).
- **Evidence:** information sent under § 92 must be marked as not usable as evidence without the approval of the Bewilligungsbehörde (§ 92 (4), [gesetze-im-internet.de](https://www.gesetze-im-internet.de/irg/__92.html)). Police-to-police information therefore starts a case abroad, but evidence still has to be obtained there or through MLA. For the operator's goal that is fine: the receiving state collects its own evidence.

**Time to effect.** Immediate (police SIENA or prosecutor e-mail). It is the fastest legal route to put a campaign on a foreign desk.

**Limits.**

- The receiver decides whether to act.
- § 61a's threshold of more than 5 years maximum penalty is met by § 263a StGB in particularly serious cases (gewerbsmäßig/Bande) and by § 269 (3) StGB **[unverified for the specific variants]**. The basic § 263a (1) carries a maximum of 5 years. That is "not more than five", so it relies on the "erhebliche Bedeutung" alternative.
- Personal data of third parties, such as victims, needs the proportionality check (§ 61a (3)).

### How phishing.support can make section 2 easier

- Produce a **"spontaneous information" sheet per country** that police can paste into SIENA or a prosecutor can attach to an e-mail. It should contain:
  - one paragraph of facts in English;
  - the infrastructure in that country;
  - indicators only (no victim personal data);
  - the German case number;
  - the contact person.
- Keep victim data separable, so the § 61a (3) / § 92b checks are trivial.
- Mark which items are **public observations** (no restriction) and which come from the provider or a victim.

---

## 3. Preservation and fast data access

### 3.1 Budapest Convention Art. 29, 30, 35 and the 24/7 network

- **Parties:** Germany has been a party since 01/07/2009, the USA since 01/01/2007, Lithuania since 01/07/2004 and the Netherlands since 01/03/2007. In total 84 states have ratified or acceded ([CoE treaty office](https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=185)).
- **Art. 29:** expedited preservation of stored data on request of another party, for at least 60 days pending an MLA request. Germany reserved the right to refuse for lack of dual criminality, except for offences under Art. 2–11 (phishing falls under Art. 7/8) ([German declarations](https://www.coe.int/en/web/conventions/full-list?module=declarations-by-treaty&numSte=185&codeNature=0&codePays=GER)).
- **Art. 30:** if, while executing a preservation request, the requested party finds a provider in a third state involved in the transmission, it must quickly disclose enough traffic data to identify that provider and path.
- **Art. 35:** each party designates a 24/7 point of contact for technical advice, preservation, evidence collection and locating suspects.
- The text of Art. 29/30/35 is in [rm.coe.int/1680081561](https://rm.coe.int/1680081561). That page sits behind a bot challenge and was not fetched; the summary above follows the official text **[unverified wording]**.

| Country | Art. 35 contact point | Source |
|---|---|---|
| Germany | "The National High Tech Crime Unit, Federal Criminal Police Office, Thaerstr. 11, D-65193 Wiesbaden" (BKA) | [CoE declarations GER](https://www.coe.int/en/web/conventions/full-list?module=declarations-by-treaty&numSte=185&codeNature=0&codePays=GER) |
| Lithuania | "Police Department under the Ministry of the Interior" | [CoE declarations LIT](https://www.coe.int/en/web/conventions/full-list?module=declarations-by-treaty&numSte=185&codeNature=0&codePays=LIT) |
| USA | DOJ Computer Crime and Intellectual Property Section | **[unverified]**: the CoE page did not render |

**Who can trigger it.** German police and prosecutors, through the BKA. A 2016 CoE list names unit SO 42 ([rm.coe.int/16804b3493](https://rm.coe.int/16804b3493)) **[unverified current unit name]**.

**Time to effect.** Hours to days **[unverified; no official statistics found]**.

**Limits.**

- Preservation only. Disclosure still needs MLA, or the provider's voluntary disclosure.
- In the US, 18 U.S.C. § 2703(f) binds providers only on request of a "governmental entity", defined as a US federal or state body (§ 2711 (4), [LII](https://www.law.cornell.edu/uscode/text/18/2711)). Preservation for 90 days, extendable by 90 ([uscode.house.gov](https://uscode.house.gov/us/usc/119-136/t18/s2703/)). A German request therefore goes through the US 24/7 point, or is a voluntary request to the provider.
- US providers **may** voluntarily disclose non-content records "to any person other than a governmental entity" (§ 2702 (c)(6), [LII](https://www.law.cornell.edu/uscode/text/18/2702)), which includes foreign police. Whether a given US hoster does this for German police is provider policy **[unverified per provider]**.

### 3.2 Second Additional Protocol (CETS 224)

- **Status:** not in force; it needs 5 ratifications and has 4: Serbia (09/02/2023), Japan (10/08/2023), Hungary (05/02/2026), Costa Rica (15/04/2026). Germany signed on 27/01/2023; the USA, Lithuania and the Netherlands signed on 12/05/2022. **None of the four has ratified** ([CoE treaty office](https://www.coe.int/en/web/conventions/full-list?module=signatures-by-treaty&treatynum=224)).
- **German ratification bill:** none found on DIP ([search result summary](https://eucrim.eu/documentation/ratifications/second-additional-protocol-to-the-convention-on-cybercrime-on-enhanced-co-operation-and-disclosure-of-electronic-evidence/)) **[unverified that none exists]**.
- **EU framework:** the Council authorised EU states to ratify with Decision (EU) 2023/436 ([EUR-Lex summary](https://eur-lex.europa.eu/EN/legal-content/summary/convention-on-cybercrime.html)).

**Tools, once in force** (Eurojust analyses; article texts not fetched):

| Article | Tool |
|---|---|
| Art. 6 | Direct request from a competent authority to a registrar in another party for domain registration data ([Eurojust Art. 6 note](https://www.eurojust.europa.eu/sites/default/files/assets/requests-for-domain-name-registration-information-under-article-6-of-the-second-additional-protocol-to-the-convention-on-cybercrime-23-01-2024.pdf)) |
| Art. 7 | Direct order to a provider in another party for subscriber information; needs domestic implementation ([Eurojust Art. 7](https://www.eurojust.europa.eu/publication/article-7-second-additional-protocol-budapest-convention-cybercrime-disclosure)) |
| Art. 8 | Government-to-government route to give effect to another party's orders for subscriber information and traffic data ([CoE overview](https://rm.coe.int/2nd-additional-protocol-budapest-convention-en/1680a2219c)) |
| Art. 9 | Emergency disclosure of stored data via the 24/7 network |
| Art. 10 | Emergency MLA; described by Eurojust as self-executing ([Eurojust Art. 10](https://www.eurojust.europa.eu/publication/article-10-second-additional-protocol-convention-cybercrime-emergency-mutual-assistance)) |

**Relevance now.** None for Germany ↔ US/LT/NL until those states ratify. Registrar data for gTLDs remains reachable through ICANN RDRS and NIS2 Art. 28 (earlier report).

### 3.3 EU e-Evidence: Regulation (EU) 2023/1543 and Directive (EU) 2023/1544

**Applicability.**

- The Regulation applies from 18 August 2026, in all member states except Denmark ([Commission e-Evidence page](https://home-affairs.ec.europa.eu/policies/internal-security/cybercrime/e-evidence_en); [BT-Drs. 21/3192](https://dserver.bundestag.de/btd/21/031/2103192.pdf)).
- What decides whether a case is cross-border is the seat of the provider's designated establishment or legal representative, not where the data sit (BT-Drs. 21/3192, Begründung A.III.1).

**German implementing law.**

- Name: Gesetz über Europäische Herausgabe- und Sicherungsanordnungen zu elektronischen Beweismitteln, inside the Elektronische-Beweismittel-Umsetzungs- und Durchführungsgesetz (EBewMG).
- Passed by the Bundestag on 29 January 2026 ([bundestag.de](https://www.bundestag.de/dokumente/textarchiv/2026/kw05-de-beweismittel-1136962)).
- Promulgated 12 March 2026. The Directive parts apply from 13 March 2026, the remaining parts from 18 August 2026 ([BfJ](https://www.bundesjustizamt.de/DE/Themen/InternationaleZusammenarbeit/Strafsachen/Evidence/Evidence_node.html)).
- Germany missed the Directive deadline of 18 February 2026 ([KriPoZ, Bentler](https://kripoz.de/2026/06/01/das-e-evidence-gesetzespaket-ein-meilenstein-in-der-grenzueberschreitenden-strafverfolgung-in-der-eu/)).
- The BfJ is the central authority and supervises providers ([BfJ](https://www.bundesjustizamt.de/DE/Themen/InternationaleZusammenarbeit/Strafsachen/Evidence/Evidence_node.html)).

**Rules relevant to phishing.**

- **Subscriber data and identification-only data (such as IP addresses):** the Staatsanwaltschaft may order them for **any** offence (BT-Drs. 21/3192, Begründung A.III.1).
- **Traffic and content data:** need a court and an offence with a maximum of at least 3 years, or a listed offence. The traffic/content condition is from the same page; the "3 years or listed offence" rule is per [KriPoZ](https://kripoz.de/2026/06/01/das-e-evidence-gesetzespaket-ein-meilenstein-in-der-grenzueberschreitenden-strafverfolgung-in-der-eu/).
- **Domestic-case test:** an order may be issued only if a similar order "in einem vergleichbaren nationalen Fall unter denselben Voraussetzungen ergehen könnte" (BT-Drs. 21/3192, Begründung A.III.1).
- **Deadlines:**
  - production within 10 days, or 8 hours in an emergency ([BfJ](https://www.bundesjustizamt.de/DE/Themen/InternationaleZusammenarbeit/Strafsachen/Evidence/Evidence_node.html));
  - preservation 60 days from receipt, extendable (BT-Drs. 21/3192, Begründung on Art. 11 of the Regulation; KriPoZ: 60 + 30 days);
  - for traffic and content data, the enforcing state is notified and may refuse within 10 days, or 96 hours in an emergency (KriPoZ).
- **Germany cannot issue EPOC-PRs:**
  - The Commission's readiness table (6 Nov 2026) lists Germany as legally and technically ready to **issue EPOCs** and to **receive EPOCs and EPOC-PRs**, but not to issue EPOC-PRs. Hungary, Italy, Slovakia and Sweden are listed for "EPOCs and EPOC-PRs" ([Commission readiness PDF](https://commission.europa.eu/document/download/5b3c2ee0-4055-4694-82c3-dc265cd6f108_en?filename=Information%20on%20Member%20States%20ready%20to%20issue%20and%20or%20receive%20EPOCs%20and%20EPOCS-PR.pdf)).
  - KriPoZ explains why: Germany has no domestic preservation order, and the 2024 draft provision (§ 9) was dropped, so the "similar domestic case" test fails for preservation ([KriPoZ](https://kripoz.de/2026/06/01/das-e-evidence-gesetzespaket-ein-meilenstein-in-der-grenzueberschreitenden-strafverfolgung-in-der-eu/)).
  - Germany's Quick-Freeze bill BT-Drs. 21/6581 would fill this gap only for telecom traffic data (earlier report).
- **Readiness of other states:** only seven member states appear in the table: Finland, Germany, Hungary, Ireland, Italy, Slovakia, Sweden. **The Netherlands and Lithuania are not listed** (same PDF).
- **When the IT system is unavailable:** the Commission's informal guidance allows S/MIME e-mail, secure cloud or traceable courier delivery under Art. 19 (5) ([contingency guidance, 11 July 2026](https://commission.europa.eu/document/download/1a0a704c-42b5-4ed0-a440-e4227eb0ec40_en?filename=Commission%20Guidance%20on%20contingency%20arrangements.pdf)).
- **IT system:** technical specifications are in Implementing Regulation (EU) 2025/1550 ([EUR-Lex](https://eur-lex.europa.eu/eli/reg_impl/2025/1550/oj)). The BfJ connects registered providers to the reference environment "JUDEX" ([BfJ](https://www.bundesjustizamt.de/DE/Themen/InternationaleZusammenarbeit/Strafsachen/Evidence/Evidence_node.html)). The German bill expects prosecutors to use e-CODEX and the e-EDES reference implementation (BT-Drs. 21/3192, Stellungnahme section).
- **Practice reports:**
  - The BMJ reported only 193 provider registrations with the BfJ by 18 August 2026, against about 9,000 expected (Heuking, [secondary](https://www.heuking.de/en/news-events/newsletter-articles/detail/e-evidence-act-in-force-what-service-providers-need-to-know.html)) **[unverified]**.
  - No official statistics on orders issued since August 2026 were found.
  - SIRIUS published guidelines for filling in EPOC and EPOC-PR forms (15 June 2026, per [Eurojust cybercrime page](https://www.eurojust.europa.eu/crime-types-and-cases/crime-types/cybercrime)).

**Relevance for the operator's goal.**

- e-Evidence is the opposite approach: Germany gets the data itself, without the hosting country opening a case.
- It is fast and avoids MLA for providers that have an EU establishment or legal representative. Whether US hosters such as Render, Vercel or Cloudflare have designated one is **[unverified]**: the European Court Database of designations is not public as far as found.
- It does **not** cover preservation from Germany. It is useful as the fallback when the hosting state does not open a case.

### 3.4 USA: CLOUD Act and EU–US agreement

- **CLOUD Act executive agreements:** the DOJ lists only the UK (signed 3 Oct 2019) and Australia (15 Dec 2021). The EU entries are only the 2019 start and the 2023 resumption of negotiations ([DOJ](https://www.justice.gov/criminal/cloud-act-resources); page last updated 24 Oct 2023).
- **Current state:** secondary sources describe the talks as stalled in 2026 ([TechTimes](https://www.techtimes.com/articles/324813/20260818/eu-e-evidence-regulation-takes-effect-tech-companies-replace-courts-rights-gatekeepers.htm)) **[unverified]**.
- **Consequence:** for US-hosted infrastructure the routes are an Anzeige to the DOJ via the BfJ (RiVASt Länderteil USA), MLA, the 24/7 network for preservation, or voluntary disclosure by the provider.

### How phishing.support can make section 3 easier

- **Per provider, record:**
  - the legal entity and country;
  - any EU designated establishment or legal representative (needed as the EPOC addressee);
  - the law-enforcement portal or e-mail;
  - known retention.
- **Pre-fill an EPOC data block** that maps to Annex I of the Regulation and § 8 EBewMG ("Teilnehmerdaten" = Bestandsdaten; "Identifizierungsdaten" = Nutzungsdaten under § 2 (2) Nr. 3a TDDDG). Fields:
  - provider and addressee;
  - identifiers (subdomain, account e-mail if known, IP plus port and UTC timestamp);
  - requested category (subscriber / identification only);
  - time window;
  - offence with maximum penalty;
  - emergency yes/no.
- **Pre-fill a 24/7 preservation block for the BKA:** provider, identifiers, time window, offence, the reason data may be lost (for example "account suspended on <date>, provider purges after 30 days"), and the German case number.
- **For US providers, generate a separate block** stating that it is meant for the US 24/7 channel or as a voluntary request under § 2702 (c)(6). Never present it as a § 2703(f) request, which only US authorities can make.

---

## 4. Coordinating several national proceedings

### 4.1 Framework Decision 2009/948/JHA (conflicts of jurisdiction)

Source for this subsection: Official Journal text, [vertic.org PDF copy](https://www.vertic.org/media/National%20Legislation/European%20Union/English/Decision_948_2009_EN.pdf); EUR-Lex record [32009F0948](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:32009F0948).

**What it does.**

- **Art. 5 (duty to contact):** an authority with reasonable grounds to believe that parallel proceedings run in another member state must contact it.
- **Art. 6 (duty to reply):** the contacted authority must reply within any reasonable deadline set, or without undue delay. It must treat the request as urgent if the suspect is in custody.
- **Art. 10 (duty to consult):** where parallel proceedings exist, the authorities "shall enter into direct consultations in order to reach consensus on any effective solution … which may, where appropriate, lead to the concentration of the criminal proceedings in one Member State".
- **Art. 12:** if no consensus, the matter is referred to Eurojust "where appropriate".
- **Scope:** "parallel proceedings" means the same facts and the same persons (Art. 3, per [CJEU C-129/14](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:62014CJ0129) summary). For an "unknown offender" phishing case the "same persons" element is uncertain **[unverified how authorities apply it to proceedings against unknown persons]**.

**Who can trigger it.** Competent judicial authorities only.

### 4.2 Ne bis in idem

- **Rules:** Art. 54 CISA and Art. 50 of the Charter bar a second prosecution for the same acts once a case is finally disposed of.
- **Kossowski (C-486/14):** a prosecutor's discontinuation "without a detailed investigation" is not a final disposal ([EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex:62014CJ0486); [Eurojust case-law overview](https://www.eurojust.europa.eu/sites/default/files/assets/2024-cjeu-case-law-on-ne-bis-in-idem.pdf)).
- **Practical meaning:**
  - A German § 170 (2) StPO closure for an unknown offender does not block a Dutch or Lithuanian case.
  - Parallel cases are lawful until one ends in a judgment or a decision on the merits.
  - Coordination matters at the end, when deciding where to try the suspects, and is the reason to involve Eurojust early.
- **Reg. 2024/3011:** lists ne bis in idem as a mandatory refusal ground (Art. 12 (1)(b), [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/3011/oj/eng)).

### 4.3 Eurojust

**How a case opens.**

- A national judicial authority of a member state, or of a third state with a Liaison Prosecutor at Eurojust, sends a request through its **National Desk**. The EPPO and the College on its own initiative can also open cases ([Eurojust life cycle](https://www.eurojust.europa.eu/judicial-cooperation/tasks-and-tools/life-cycle-case)).
- Private persons are not mentioned (same page).
- Germany's desk is reached by the Staatsanwaltschaft. The case referral itself needs no formality beyond the request **[unverified: form not published]**.

**Tools.** The following come from the life-cycle page, [what we do](https://www.eurojust.europa.eu/about-us/what-we-do) and [coordination centres](https://www.eurojust.europa.eu/judicial-cooperation/tasks-and-tools/coordination-centres):

- urgent handling, plus a 24/7 on-call coordination service;
- identifying counterparts, including third states;
- cross-matching data with Europol;
- coordination meetings with judicial and police authorities, to plan the use of EIO, MLA and freezing orders and to settle jurisdiction and ne bis in idem questions;
- JITs;
- action days run from a coordination centre with SIENA and SIS access.

**Third states.**

- Liaison Prosecutors are posted from Albania, Georgia, Iceland, Moldova, Montenegro, North Macedonia, Norway, Serbia, Switzerland, Ukraine, the UK and the **USA** ([Eurojust](https://www.eurojust.europa.eu/states-and-partners/third-countries/liaison-prosecutors)).
- Other states are reached through a contact-point network ([link on Eurojust site](https://www.eurojust.europa.eu/states-and-partners/third-countries/contact-points)) **[not fetched]**.

**JITs.**

- A JIT is an agreement between the competent authorities of two or more states, usually for 12–24 months. It allows direct exchange of information and evidence, and participation in measures on each other's territory ([Eurojust JIT page](https://www.eurojust.europa.eu/judicial-cooperation/eurojust-role-facilitating-judicial-cooperation-instruments/joint-investigation-teams)).
- JITs with third states are possible. Guidelines and a data-protection checklist exist. Newly established JITs with third states supported by Eurojust rose from 3 in 2016 to 32 in 2021 (same page).
- **German basis:** § 93 IRG for EU states and § 61b IRG where a treaty provides for JITs. Members may pass officially obtained information, including personal data, "unmittelbar" to the other members ([§ 93](https://www.gesetze-im-internet.de/irg/__93.html), [§ 61b](https://www.gesetze-im-internet.de/irg/__61b.html)). The RiVASt covers JITs in Nr. 142c ([gesetze-bayern.de](https://www.gesetze-bayern.de/Content/Document/RiVASt/true)).

**JIT funding** ([FAQ](https://www.eurojust.europa.eu/judicial-cooperation/instruments/joint-investigation-teams/jits-funding/jits-funding-faq), [funding page](https://www.eurojust.europa.eu/judicial-cooperation/instruments/joint-investigation-teams/jits-funding)):

- **Covered:** travel, accommodation, translation, interpretation, expertise, transfer of items, and low-value IT equipment.
- **Not covered:** pre-financing.
- **Ceilings:** up to EUR 50,000 per standard application, submitted through the JITs Funding Portal during calls; up to EUR 8,000 for urgent applications at any time.
- **Precondition:** a signed JIT agreement.
- **2026 call dates:** inconsistent across Eurojust pages **[unverified]**.

**Cybercrime support.**

- The European Judicial Cybercrime Network (EJCN), founded in 2016, is hosted by Eurojust. Eurojust and the EJCN publish the Cybercrime Judicial Monitor yearly ([Eurojust cybercrime](https://www.eurojust.europa.eu/crime-types-and-cases/crime-types/cybercrime)).
- Example of a Eurojust-coordinated cyber case: in the iSpoof case the UK opened the Eurojust case in October 2021. Eurojust held two coordination meetings, and US and Ukrainian authorities seized the server ([Eurojust](https://www.eurojust.europa.eu/news/action-against-criminal-website-offered-spoofing-services-fraudsters-142-arrests)).

**Time to effect.** Rapid-response cases take days. Coordinated cases take months **[unverified; no timelines published]**.

### 4.4 Europol EC3

- **Mandate:** EC3 supports member states' investigations with operational, strategic, analytical and forensic support, and provides 24/7 support for urgent incidents. It also hosts the **J-CAT** ([Europol EC3](https://www.europol.europa.eu/about-europol/european-cybercrime-centre-ec3)).
- **J-CAT:** cyber liaison officers from member and partner agencies sit together. It selects cases mainly from members' proposals; the proposing country leads an action plan. Cases need links to at least two J-CAT members ([J-CAT poster 2022](https://www.europol.europa.eu/cms/sites/default/files/documents/J-CAT%20Poster%202022.pdf)). Germany is a member (same poster).
- **Analysis projects:** AP Cyborg (cyber-dependent crime) and AP Terminal (online and electronic payment fraud) are EC3's projects relevant to phishing ([Europol analysis-projects page, via search](https://epolmx.europol.europa.eu/crime-areas-trends/europol-analysis-projects); [IOCTA 2018](https://www.europol.europa.eu/sites/default/files/documents/iocta_2018_0.pdf)). Their current names and structure are **[unverified]**; the sources date from 2018–2022.
- **What an AP does:** it cross-matches contributions from all member states and produces intelligence packages. A German contribution via the BKA can therefore reveal a Dutch or Lithuanian case on the same bot ID, wallet or kit. That is the trigger for 4.1 and 4.3.
- **Channel:** SIENA. It is mandatory for police exchanges under Directive 2023/977 Art. 13 (section 2).
- **Private parties:** under Art. 26 (2) of the Europol Regulation as amended by Reg. 2022/991, "Where Europol receives personal data directly from private parties, it may process those personal data … in order to identify the national units concerned". It "shall forward the personal data and any relevant results … for the purpose of establishing jurisdiction immediately to the national units concerned" ([Europol-hosted copy](https://www.europol.europa.eu/cms/sites/default/files/documents/CELEX_32022R0991_EN_TXT.pdf)).
  - Data are erased if no unit resubmits them within four months.
  - Europol's public page still tells citizens to go to national police ([earlier report](criminal-referral-routes.md)).
  - In practice private input arrives through the EC3 Advisory Groups and the Cyber Intelligence Extension Programme (CIEP), which is how Tycoon2FA started ([Europol](https://www.europol.europa.eu/media-press/newsroom/news/global-phishing-service-platform-taken-down-in-coordinated-public-private-action)).
- **EMPACT 2026–2029:** the Council's priorities include "the fastest-growing online crimes: cyber-attacks, online child sexual exploitation, and online fraud schemes" ([Council press release, 13 June 2025](https://www.consilium.europa.eu/en/press/press-releases/2025/06/13/council-defines-eu-crime-fighting-priorities-for-next-years/)). Phishing for credentials and payment data falls under online fraud schemes and cyber-attacks. Which operational action plan covers phishing kits is **[unverified]**.

**Who can trigger it.** Member-state police through their Europol national unit; in Germany that is the BKA. Private parties can trigger the limited Art. 26 (2) identification step.

### 4.5 Interpol

- **Pattern:** Interpol runs regional cyber operations built on "Cyber Activity Reports" produced with private partners.
  - Operation Secure (2025): Group-IB, Kaspersky and Trend Micro produced the reports; more than 20,000 malicious IPs and domains were taken down and 41 servers seized ([Interpol](https://www.interpol.int/News-and-Events/News/2025/20-000-malicious-IPs-and-domains-taken-down-in-INTERPOL-infostealer-crackdown)).
  - Synergia III (July 2025 – January 2026): 72 countries; more than 45,000 malicious IP addresses and servers taken down ([Interpol](https://www.interpol.int/en/News-and-Events/News/2026/45-000-malicious-IP-addresses-taken-down-in-international-cyber-operation)).
- **Who can trigger it:** member countries through their National Central Bureau, which for Germany sits at the BKA **[unverified on interpol.int]**. Private parties take part as partners of Interpol, not as reporters.
- **Relevance:** mainly for infrastructure in states outside the EU and the Budapest network.

### How phishing.support can make section 4 easier

- **Keep a per-campaign register of every proceeding and report known anywhere:** country, authority, case number, date, contact. This is the input for FD 2009/948 Art. 5, Eurojust's "identify counterparts", and Reg. 2024/3011 Art. 5 (2)(f)/(g).
- **Export the linking indicators in machine-readable form**, so the BKA can contribute them to Europol and get cross-matches. Examples: kit file hashes, bot IDs and chat IDs, collector hosts, wallets, IBANs, origin IPs.
  - Use one flat CSV plus STIX 2.1 or MISP JSON. The format is a proposal; no Europol format requirement was found **[unverified]**.
- **Draft the coordination ask to ZCB in one paragraph**, for example: "Bitte prüfen: Befassung von Eurojust (deutscher Tisch) zur Feststellung paralleler Verfahren in NL/LT/US und ggf. Bildung einer JIT".
- **Ask for one human first contact**, as already planned in first-contact-zcb.md. Add a question on whether ZCB uses Eurojust and the BKA's Europol channel for phishing kits.

---

## 5. UN Convention against Cybercrime (Hanoi, 2025)

- **Status:** 96 signatories and 3 parties: Qatar (4 Feb 2026), Azerbaijan (15 Apr 2026) and Viet Nam (17 Apr 2026) ([UN Treaty Collection XVIII-16](https://treaties.un.org/Pages/ViewDetails.aspx?src=IND&mtdsg_no=XVIII-16&chapter=18&clang=_en)).
- **Signature dates:** Germany 1 Jun 2026, Lithuania 22 Sep 2026, the Netherlands 23 Sep 2026; the EU, China, Russia and the UK on 25 Oct 2025. The **United States is not listed** (same page).
- **Entry into force:** 90 days after the 40th ratification ([UN OLA](https://www.un.org/ola/en/news/united-nations-convention-against-cybercrime-opens-signature-hanoi)). Signature is open until 31 December 2026 (same source).
- **Relevance:** none for 2026–2027. Later it may give a treaty basis for preservation, spontaneous information and transfer of proceedings with states outside Budapest (for example Viet Nam and Indonesia). Article mapping is **[unverified]**; see the [UNODC full text](https://www.unodc.org/unodc/en/cybercrime/convention/text/convention-full-text.html).

---

## 6. Real cases: how hosting or infrastructure countries came to act

| Case | How it started | What the infrastructure or residence countries did | Source |
|---|---|---|---|
| **Tycoon2FA** (PhaaS, 4 Mar 2026) | Trend Micro shared intelligence with Europol, which passed it to the EC3 Advisory Groups | State Police (LV), Criminal Police Bureau (LT), PJ (PT), CBZC (PL), Policía Nacional and Guardia Civil (ES) and NCA (UK) carried out "seizure of infrastructure and other operational measures"; Microsoft took down 330 domains through CIEP | [Europol](https://www.europol.europa.eu/media-press/newsroom/news/global-phishing-service-platform-taken-down-in-coordinated-public-private-action) |
| **Kratos** (PhaaS, July 2026) | ZIT Frankfurt and BKA case with US authorities; the origin is not stated | More than 200 servers disabled; the developer was arrested **in Indonesia by Indonesian authorities**; about 850 victims in 35 countries | [BKA](https://www.bka.de/SharedDocs/Kurzmeldungen/DE/Kurzmeldungen/260720_Schlag_gegen_Phishing_Gruppierung_Kratos.html) |
| **IP proxy botnet** (11 Mar 2026) | FR, AT, NL and US found many malware victims and started working together | Eurojust sent judicial requests and EIOs to BG, DE, HU and RO, where servers stood; 24 servers in 7 countries | [Eurojust](https://www.eurojust.europa.eu/news/servers-used-cybercrime-around-world-taken-down) |
| **iSpoof** (Nov 2022) | UK opened the Eurojust case in October 2021 | US and Ukrainian authorities seized the server; 142 arrests | [Eurojust](https://www.eurojust.europa.eu/news/action-against-criminal-website-offered-spoofing-services-fraudsters-142-arrests) |
| **Phishing network in Spain and Latin America** (Sept 2024) | Group-IB informed Europol; Europol sent packages to the affected countries | ES, AR, CL, CO, EC and PE police acted with Ameripol | [Europol](https://www.europol.europa.eu/media-press/newsroom/news/criminal-phishing-network-resulting-in-over-480-000-victims-worldwide-busted-in-spain-and-latin-america) |
| **Bank-phishing gang BE/NL** (June 2022) | not stated | 9 arrests and 24 searches in NL with Europol support | [Europol](https://www.europol.europa.eu/media-press/newsroom/news/phishing-gang-behind-several-million-euros-worth-of-losses-busted-in-belgium-and-netherlands) |
| **Virtualine** bulletproof hoster (Oct 2026) | FBI and EDVA seized the domain with Polizei Hessen, Politie Midden-Nederland and the NCA | Dutch police seized dozens of servers in a Limburg data centre and data on more than 3,000 customers | secondary: [Chainalysis](https://www.chainalysis.com/blog/virtualine-bulletproof-hosting-seizure-october-2026/), [BleepingComputer](https://www.bleepingcomputer.com/news/security/police-seize-virtualine-bulletproof-service-tied-to-ransowmare-cybercrime/) **[unverified on politie.nl]** |
| **Zservers/XHost** (Feb 2025) | Dutch investigation of more than a year; US, UK and AU sanctions on 11 Feb 2025 | Amsterdam police seized 127 servers | secondary: [BleepingComputer](https://www.bleepingcomputer.com/news/legal/dutch-police-seizes-127-xhost-servers-dismantles-bulletproof-hoster/) **[unverified on politie.nl]** |
| **Unnamed bulletproof hoster** (Nov 2025) | not stated | Dutch police seized about 250 servers in The Hague and Zoetermeer; linked to more than 80 investigations, including phishing | secondary: [BleepingComputer](https://www.bleepingcomputer.com/news/security/dutch-police-seizes-250-servers-used-by-bulletproof-hosting-service/) **[unverified on politie.nl]** |
| **Operation Endgame** (Nov 2026) | NL-led, with DE, DK, UK, US and CA | Dutch police took down servers in NL (Gootloader 14, StealC 80); malware, not phishing | [politie.nl](https://www.politie.nl/en/news/2026/november/international-action-disables-cybercriminal-network.html) |

**What the cases show.**

- No primary source describes a hosting country opening its **own** phishing case solely because another country laid information under Art. 21. The documented routes are:
  - a private intelligence package to Europol, followed by packages to each affected country (Tycoon2FA, Spain/LatAm);
  - a lead country with Eurojust coordination sending requests to the server countries (proxy botnet, iSpoof);
  - the hosting country's own long-running case against a complicit hoster (Dutch bulletproof cases);
  - the suspect's residence country arresting on foreign information (Kratos, and from the earlier report 16shop and BulletProofLink).
- For phishing.support, the realistic way to get a Dutch or Lithuanian case is therefore either:
  - a German case that the BKA brings into Europol/J-CAT, or ZCB into Eurojust, as one dossier per campaign; or
  - an Anzeige zum Zwecke der Strafverfolgung directly to the Dutch or Lithuanian prosecutor when that country is clearly the centre (complicit hoster, suspects resident there).

---

## 7. Ranked best bets

1. **Parallel case abroad through a German Anzeige zum Zwecke der Strafverfolgung, then a JIT through Eurojust.**
   - ZCB keeps its own case (RiVASt 146 (4)) and sends the Dutch or Lithuanian prosecutor a direct Anzeige with the country slice (direct judicial channel per the RiVASt Länderteil). For US infrastructure the Anzeige goes through the BfJ to the DOJ.
   - Once two cases exist, Eurojust coordination and a JIT let each side collect locally and share directly (§ 93 IRG), with funding.
   - phishing.support delivers the country slices, the translations of the German provisions and the register of other proceedings.
2. **BKA → Europol (SIENA, AP Cyborg/Terminal, J-CAT) for cross-matching.**
   - Finding an existing case abroad on the same indicators is the cheapest way to get a parallel proceeding.
   - phishing.support delivers machine-readable indicators.
3. **Spontaneous information (§§ 92d/92e IRG for police, § 61a IRG for prosecutors, Budapest Art. 26).** It is the fastest way to put a campaign on a foreign desk without the formality of an Anzeige. phishing.support delivers a one-page sheet per country with no victim personal data.
4. **e-Evidence EPOC from the German prosecutor for subscriber and IP data** at providers with an EU representative, plus BKA 24/7 preservation. This is the fallback when the hosting state does not act. phishing.support pre-fills the EPOC and preservation blocks per provider.
5. **Europol Art. 26 (2) private-party submission.** Legally possible and multi-country by design. The practical channel is unclear, so ask Europol EC3 or the BKA first.
6. **Reg. 2024/3011 transfer (from 1 Feb 2027).** Only when Germany wants to give the case away to the state where the suspects sit. It is weak for pure hosting countries because of Art. 12 (2)(c).
7. **Not usable now:** CETS 224 (not in force), the 1972 Transfer Convention (Germany not a party), an EU–US agreement (none), the UN convention (3 parties).

---

## 8. Open questions

- **ZCB practice:** does ZCB use Anzeigen zum Zwecke der Strafverfolgung, Eurojust and JITs for phishing campaigns, or does it hand such cases to the ZIT or the BKA? Add this to the first-contact questions.
- **Hosting countries' jurisdiction:** does the Netherlands, Lithuania or the US treat hosting a phishing page or collector on its territory as an offence committed there? Is Lithuania bound by a legality principle? (Needs national sources or a contact.)
- **Plenary status of the IRG reform** (BT-Drs. 21/7558, committee recommendation 21/9144 of 11.11.2026) and its promulgation date.
- **e-Evidence:** whether the commonly abused US hosters (Render, Vercel, Netlify, Cloudflare) have designated an EU legal representative or establishment; and whether the Netherlands and Lithuania can already receive EPOCs despite missing from the readiness table.
- **Europol Art. 26 (2):** is there an operational channel for a private, non-commercial reporter, and in what format?
- **US 24/7 point of contact** and the current BKA unit name for the German 24/7 point.
- **EMPACT 2026–2029:** which operational action plan covers phishing kits, and whether Germany leads or takes part.
- **Exact wording of Budapest Art. 29/30/35, Reg. 2023/1543 Art. 6/11 and FD 2009/948 Art. 3:** the official pages were behind bot protection; re-check if exact quotes are needed.
