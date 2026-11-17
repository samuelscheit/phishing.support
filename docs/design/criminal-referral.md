# Design: criminal referral and preservation

Status: phases 1 and 2 implemented, 2026-11-17. Research basis: [criminal-referral-routes.md](../research/criminal-referral-routes.md).

Decisions taken with the operator:

- **Complainant:** the operator in person, with postal address (`REFERRAL_COMPLAINANT_*`).
- **Approval:** every mail to an authority or provider is approved individually; nothing is sent automatically.
- **Exfiltration channels:** reported to their platform immediately as before; also included in the dossier.
- **Authorities:** Bavarian, for a complainant in 85609 Aschheim (Landkreis München). The first choice is the Zentralstelle Cybercrime Bayern, which takes informal mails; the alternatives are the LKA ZAC and the Staatsanwaltschaft München I. The StA München I advises against e-mail because the justice network blocks some of it.

## Goal

The aim is to turn what phishing.support already finds into criminal cases that someone actually works on, and to keep providers from purging the data police will ask for. Success is measured as:

- the number of case numbers received;
- the number of supplements sent to open cases;
- the number of providers that confirm they preserved data.

It is not the number of sent mails.

## Principles from the research

1. **Campaign, not site.** Prosecutors act on a package that links many sites to one actor. A single site with an unknown operator is closed under § 170 (2) StPO.
2. **Named complainant, written Strafanzeige, case number.** A written Strafanzeige from a named complainant is the only route that obliges an authority to review and gives the tool a case number to build on.
3. **Supplements beat new reports.** Every later site of the same campaign goes to the same case number.
4. **Preservation needs the case number.** Ask for suspension instead of purge in every takedown report. After the case number arrives, send each provider a preservation notice that quotes it, and give the investigator the request templates for each provider.
5. **Do not destroy evidence while protecting victims.** Exfiltration channels are the strongest lead. See the policy below.

## Domain

### Campaign

A campaign is a set of website submissions linked by at least one **strong indicator**:

| Indicator | Source today | Strength |
|---|---|---|
| Exfiltration backend: Telegram bot ID, Discord webhook ID, collector host | `exfiltration/*`, `investigation.backendCount` | strong: one operator |
| Payment receiver: IBAN, wallet, merchant or QR receiver | new extraction from the visit record | strong |
| Kit fingerprint: hash of a kit-specific script or stylesheet or hidden frame | `abuse/origin/siblings.ts` `kitFingerprints` | strong only when the resource is not a public library (reuse the `popular_domains` filter) |
| Origin IP that serves the kit body directly | `abuse/origin/*` | medium: counts only together with a matching kit fingerprint, because shared hosting would merge unrelated actors |

Clustering is union-find over these links. Each link is persisted with its kind, value and the evidence artifact that proves it. A new submission that bridges two campaigns merges them, and the merge is recorded as an event. Campaigns are derived data, so a full rebuild from the stored links must give the same result.

### Authority

An authority is a static definition, like a provider definition today, with these fields:

- jurisdiction
- intake address
- language
- whether it accepts supplements by e-mail
- selection criteria: which brand country, victim country or hosting country it covers

Examples are the complainant's local Staatsanwaltschaft or police cybercrime unit, ZIT Frankfurt (escalation only), and the NCSC-UK intelligence mailbox (no case).

### Referral

A referral is one campaign sent to one authority. It has these states:

`draft → awaiting_approval → sent → acknowledged(case number) → supplementing → closed(reason)`

It also holds the case number, the investigator's contact once known, and every mail in both directions.

## Option A (implemented): a referral is an abuse report

The existing aggregate (`abuse_reports`, `abuse_targets`, `abuse_provider_routes`, `abuse_mail_messages`, `abuse_events`, `abuse_jobs`) already covers outbound mail, inbound reply correlation, reply classification, the follow-up agent, the audit trail and the status UI. A referral would be:

- an abuse report with `allegationCategory = "criminal_referral"` and no `submissionId`;
- with the campaign's domains and backends as targets;
- with one `email` route per authority, under the registry key `authority:<id>`.

Changes needed:

- `campaignId` on `abuse_reports`.
- A new reply classification `case_opened`, plus a `caseReference` column on the route that the classifier fills from the reply (patterns such as `Az.`, `Tgb.-Nr.`, `Vorgangsnummer`, `UJs`/`Js` file numbers).
- A new job type `send_referral_supplement` and a new job type `send_preservation_notice`.

The trade-off: the reply machinery and the UI are reused. The cost is that `abuse_reports` gets a third kind of owner, campaign next to submission and API.

## Option B: a separate referral aggregate

New tables `referrals` and `referral_messages`, with their own mail correlation. This keeps the separation clean, but it duplicates sending, IMAP correlation, classification and events, which the repository rules forbid. **Not recommended.**

## Dossier

The dossier is built from stored data only. An LLM writes the narrative, but it may cite only facts present in the structured data, the same rule the follow-up agent follows.

1. **Strafanzeige gegen Unbekannt (criminal complaint against persons unknown).** It names the complainant, the suspected offences (§§ 263a, 269, 202a ff. StGB, § 143 MarkenG), a short account of what happened, and the request to preserve data and to investigate.
2. **Campaign overview.** Number of sites, period, targeted brands, the victim region the page language points to, and the indicators that link the sites.
3. **Site table.** URL, first seen, registration date, hosting, registrar and CDN, takedown status with the provider's ticket, and evidence hashes.
4. **Leads for compulsory measures, one block per provider.** What data exists there and which instrument reaches it. Examples: Telegram via a judicial order; Hostinger's preservation process; a European Preservation Order for EU hosts; 18 USC 2703(f) through the BKA 24/7 contact for US hosts. Each block comes with a prefilled request text.
5. **Evidence.** The existing manifests with RFC 3161 timestamps. Captures are linked through an authenticated download URL with a token, plus hashes, instead of being attached, because police mail servers reject large attachments.

Supplements reuse sections 3 to 5, filtered to what is new since the last mail, and are sent at most once a week per case.

## Preservation

1. **Immediately, for every takedown report:** add a fixed paragraph to every provider draft: *"Please suspend rather than delete. Retain account, payment and access-log data for at least 90 days; a criminal complaint is pending and a law-enforcement request may follow."*
2. **When a case number arrives:** send a preservation notice quoting the case number and naming the authority to every provider route of the campaign's members. This reuses the existing routes and their mail threads.
3. **For the investigator:** the dossier's section 4 contains the request templates for each provider.

## Exfiltration-channel policy

There are three options:

- **(a)** Report immediately, as today. This protects victims but may destroy the lead.
- **(b)** Hold the report of Telegram and Discord backends while the campaign has an open referral, and release it when the investigator confirms or after a configurable deadline.
- **(c)** Report immediately and include the backend in the dossier right away, so police can ask before the account is deleted.

Option (c) is implemented, by the operator's decision: protecting the next victims comes first, and the dossier carries the bot ID, token and chat ID so police can still request the account.

## Triggers and autonomy

Every campaign can be referred. The campaign page drafts a complaint, a supplement (only the sites the authority has not received) or the preservation notices. Each drafted mail is a route in `awaiting_approval`, and the operator can edit, approve or discard it. Approval fixes the text and queues delivery in one transaction.

## Machine-readable channels (phase 3)

- **Chainabuse** provider for wallet targets (API, batch, law-enforcement contact opt-in).
- **NCSC-UK** `report@phishing.gov.uk` and brand mailboxes as additional e-mail routes. These are takedown and intelligence routes, not cases.
- **APWG eCX** after the membership or Researcher Data Grant application.

## Phases

1. **Phase 1:** preservation paragraph in all takedown drafts; campaign clustering with persisted links; campaign page in the UI; dossier export.
2. **Phase 2:** authorities, referral routes, the approval gate, case-number extraction, supplements and preservation notices.
3. **Phase 3:** Chainabuse, NCSC-UK, brand mailboxes, APWG; manual escalation of PhaaS-scale clusters to ZIT/BKA and vendors.

## Outside the tool (human steps)

- One first contact with the local Schwerpunktstaatsanwaltschaft or police cybercrime unit, to agree on a standing supplement channel.
- The APWG membership application.
- Introductions to vendor law-enforcement desks (Trend Micro, Microsoft DCU) for PhaaS-scale clusters.
