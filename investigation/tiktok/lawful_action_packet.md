# Lawful action packet — Vietnamese TikTok-recharge campaign

> **Prepared:** 2026-10-05 (client date; investigative timestamps below are UTC unless explicitly labelled otherwise)
>
> **Purpose:** factual, non-accusatory drafts for voluntary abuse reporting and lawful preservation requests. This file does **not** identify a private person, and no form, email, post, or law-enforcement submission was made while preparing it.
>
> **Evidence boundary:** this packet uses the preserved derivatives and public-source records under `investigation/tiktok/`. It does not reproduce private registrant data, temporary session cookies, transaction tokens, passwords, OTPs, payment-card data, prepaid-card serial/PIN values, or raw unrelated credential-like material.

## 1. How to use this packet

1. Replace only the clearly marked reporter/contact/jurisdiction placeholders with the user's own information.
2. Submit the relevant draft through the official channel named in that section. Do not claim to represent TikTok, Cloudflare, Hostinger, ZaloPay, IMEDIA, a bank, or law enforcement.
3. Use only the recipient-specific sanitized summary/derivatives in [section 6](#6-evidence-bundle-and-hash-handling). Do not send raw headers or session-bearing captures unless a provider or authority requests them through a secure channel.
4. Preserve each confirmation number, email thread, upload receipt, and provider response in a separate action log. Do not post the evidence publicly.
5. Keep all times in UTC as written. If a form requires local time, include both the local conversion and the original UTC timestamp.

**Attribution rule:** evidence supports a common page template for 21 of 22 reported URL/IOC entries. One entry has no content capture and is not independently verified as a page in that template. Shared content, DNS, an IP allocation, registrar records, and a payment receiver label do **not** establish common ownership or identify an operator. No public account, provider, business, or private person is named as the threat actor in this packet.

## 2. Factual case summary

The preserved case contains **20 historical reported URL/IOC entries** first recorded from `2026-08-19T08:55:17Z` through `2026-08-31T18:22:24Z`, plus **two later continuation entries** recorded at `2026-09-01T08:08:00Z` and `2026-09-01T09:05:07Z`. These are 22 records, not 22 independently verified page captures. Content evidence is available for **21**: 19 historical MHTML captures, one continuation MHTML capture (`napxu.aoanh-media.space`), and one direct HTTP response body (`napxu.caothaisonmedia.shop`). `shop.sonhaimedia.sbs` has no MHTML artifact; its source submission reports a DNS resolution failure, and a later vhost check returned a default page, not the campaign content. It remains an unverified related IOC only.

The captured pages use Vietnamese TikTok Coins language, TikTok-style branding, coin bundles, payment logos, and a recharge flow that presented as TikTok Coins top-up. The captured client-side routes include `POST /login`, `POST /qr_order`, `GET /qr_status?order_id=...`, `POST /buy`, `GET /cards`, and `POST /logout`. The captured login form asks for a TikTok username/ID only; **no password field was present**. The card path constructs fields named `telco`, `amount`, `serial`, and `code` for a request to `/buy`. This supports an intended prepaid-card submission path; it does not show that a real card value was submitted or harvested.

A read-only synthetic/public-username probe created order **7052** at `2026-09-01T02:35:00Z` for VND 50,000 (pay amount VND 48,500). A read-only ZaloPay dynamic-QR lookup at `2026-09-01T03:25:35Z` reported receiver `IMEDIA JSC`, receiver account `Z397926244101696205`, `app_id=4982`, and partner `Zalopay` / Công ty cổ phần Zion. The QR metadata set expiry to `2026-09-01T02:49:59Z`; the final status check at `2026-09-01T04:06:01Z` returned `expired`. **No payment was made.**

Direct Host-header requests established the same fake application at `103.149.86.246:80` for `napxu.hungdungmedia.fun` at `2026-09-01T04:18:16Z` and `napxu.caothaisonmedia.shop` at `2026-09-01T11:02:24Z`. The RIR allocation for `103.149.86.0/23` is recorded to 4S TECHNOLOGY TRADING SERVICES COMPANY LIMITED / AS149125; this is a network/allocation role, not proof of a VPS subscriber or operator. Ten other roots had an authoritative apex A association with `.246`; that is not direct proof that each named subdomain served the phishing body.

## 3. Reported URLs and source timestamps

The following table is generated from the two preserved IOC exports. “First report/observation” and registration times are copied as recorded in those exports; they do not establish that a domain is live on 2026-10-05. The `shop.sonhaimedia.sbs` row has no campaign-page capture and is included only as an unverified related IOC.

| Cohort | Host / exact reported URL | Submission ID | First report/observation (UTC) | Registration (UTC) | Origin evidence at packet cutoff |
|---|---|---:|---|---|---|
| historical cohort | `napxu.gnshop.fun`<br>https://napxu.gnshop.fun/ | `348389447261229079` | `2026-08-19T08:55:17Z` | `2026-06-14T01:58:58.733Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `nap-xu-247.vntik.shop`<br>https://nap-xu-247.vntik.shop/ | `348421337477287968` | `2026-08-19T11:02:00Z` | `2026-03-19T08:53:11.0Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `napxu247.muanhanh.shop`<br>https://napxu247.muanhanh.shop/ | `348539296447205417` | `2026-08-19T18:50:43Z` | `2026-08-14T06:59:47.0Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `napxu.dltiktik.shop`<br>https://napxu.dltiktik.shop/ | `348756442276171825` | `2026-08-20T09:13:35Z` | `2026-08-19T16:47:26.0Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `napxunhanhre.khuyenmai2026.site`<br>https://napxunhanhre.khuyenmai2026.site | `348866265474928698` | `2026-08-20T16:29:59Z` | `2026-08-14T07:00:08.739Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `napxu.takimedia.shop`<br>https://napxu.takimedia.shop/ | `349031076745711685` | `2026-08-21T03:24:53Z` | `2026-08-20T23:38:28.0Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `nap-xu.sky1media.shop`<br>https://nap-xu.sky1media.shop | `350078878372335632` | `2026-08-24T00:48:28Z` | `2026-08-20T23:32:40.0Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `nap-xu.thuynmedia.shop`<br>https://nap-xu.thuynmedia.shop | `350354710311473187` | `2026-08-24T19:04:32Z` | `2026-08-24T16:39:51.0Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `napxu.thuytongstore.fun`<br>https://napxu.thuytongstore.fun/ | `350466798270812200` | `2026-08-25T02:29:56Z` | `2026-08-25T01:56:00.327Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `shop-xu.kimsonmedia.sbs`<br>https://shop-xu.kimsonmedia.sbs/ | `350930905994367026` | `2026-08-26T09:14:07Z` | `2026-08-26T07:43:44.0Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `shop.huuhanstudio.space`<br>https://shop.huuhanstudio.space/ | `351387190816673794` | `2026-08-27T15:27:14Z` | `2026-08-27T08:20:21.125Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `shop.sonhaimedia.sbs`<br>https://shop.sonhaimedia.sbs/ | `351624943487684609` | `2026-08-28T07:11:59Z` | `2026-08-26T08:32:50.0Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `shop.dainammedia.space`<br>https://shop.dainammedia.space/ | `352185586284498946` | `2026-08-29T20:19:47Z` | `2026-08-29T14:16:28.648Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `napxu.hoanghaimedia.shop`<br>https://napxu.hoanghaimedia.shop/ | `352342673387950094` | `2026-08-30T06:43:59Z` | `2026-08-30T05:07:45.0Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `napxu.ko-media.art`<br>https://napxu.ko-media.art/ | `352730056440680448` | `2026-08-31T08:23:18Z` | `2026-08-31T07:11:30.0Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `shop.hd-media.space`<br>https://shop.hd-media.space/ | `352784145123905536` | `2026-08-31T11:58:14Z` | `2026-08-31T07:27:16.097Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `napxu.quangthaimedia.shop`<br>https://napxu.quangthaimedia.shop/ | `352799328705712141` | `2026-08-31T12:58:34Z` | `2026-08-31T08:45:28.0Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `napxu.quanghung-media.site`<br>https://napxu.quanghung-media.site/ | `352832125797404695` | `2026-08-31T15:08:54Z` | `2026-08-31T08:57:14.830Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| historical cohort | `napxu.hoanganhmedia.sbs`<br>https://napxu.hoanganhmedia.sbs/ | `352854759947898915` | `2026-08-31T16:38:50Z` | `2026-08-31T14:16:48.0Z` | 103.149.86.246 appears only in the root/apex A snapshot; not direct vhost proof (`103.149.86.246`) |
| historical cohort | `napxu.hungdungmedia.fun`<br>https://napxu.hungdungmedia.fun/ | `352880825026482223` | `2026-08-31T18:22:24Z` | `2026-08-31T14:26:14.609Z` | direct Host-header proof at 103.149.86.246:80 (`103.149.86.246`) |
| post-cutoff continuation | `napxu.aoanh-media.space`<br>https://napxu.aoanh-media.space/ | `353088590453936100` | `2026-09-01T08:08:00.000Z` | `2026-09-01T06:47:15.903Z` | unknown; observed DNS values are Cloudflare proxy/edge or no answer |
| post-cutoff continuation | `napxu.caothaisonmedia.shop`<br>https://napxu.caothaisonmedia.shop/ | `353102966678360060` | `2026-09-01T09:05:07.000Z` | `2026-09-01T06:38:53.0Z` | direct Host-header proof at 103.149.86.246:80 (`103.149.86.246`) |

**Canonical exports:** [campaign_iocs.csv](campaign_iocs.csv), [campaign_iocs.json](campaign_iocs.json), [campaign_continuations.csv](campaign_continuations.csv), and [campaign_continuations.json](campaign_continuations.json).

## 4. Observed behavior and safe characterization

### 4.1 Brand and offer

* Page title/heading: `Nạp xu TikTok` / `Nạp xu TikTok - Trung tâm nạp xu TikTok`.
* Visible bundles ranged from 350 coins / VND 50,000 to 35,000 coins / VND 5,000,000.
* Pages displayed TikTok-style logo/coin/help/security cues and Visa, MoMo, VNPay, ZaloPay, ZingPay, Viettel, Mobifone, Vinaphone, and Garena payment imagery.
* The official TikTok purchase URL is `https://www.tiktok.com/coin`; the reported hosts are not TikTok-owned domains.

### 4.2 Account and payment paths

* `POST /login` accepts a username/ID and returns profile/session data during safe public-ID probes. Do not describe this as password theft; the captured form had no password field.
* `POST /qr_order` and `GET /qr_status?order_id=...` implement a QR payment path.
* `POST /buy` receives `telco`, `amount`, `serial`, and `code` fields for the prepaid-card path. The investigation did not submit a real card/PIN/serial.
* The client contains an allowlisted local “fake order” branch that avoids `/qr_order`; this is source-level evidence of deceptive behavior in the copied client, not an operator identity.

### 4.3 Template and origin correlation

* The 19 stored historical MHTML captures normalize to **16,276 bytes** with SHA-256 `f248a056b185e69f5441cd4b9a1eaa705f289109a9b3ab891afe05c4bd17889d`.
* `napxu.aoanh-media.space` has the same normalized HTML hash and **32/32** shared campaign asset matches.
* The direct `caothaison` body is byte-identical to `live_final_direct.html` after replacing only the hostname; its raw body is 186,883 bytes with SHA-256 `2659d10a2db6bf1ad56766f89767a3054f2defb7271a089678f2f1efadc7eee3`.
* The common asset family contains 32 named `/public/images/tiktok/...` files. The exact asset hashes and comparison method are in [template_fingerprint.json](template_fingerprint.json).

## 5. Current public leads (not identity findings)

| Lead | What is supported | What is not supported | Next lawful record to request |
|---|---|---|---|
| Public source-code correlation (not a suspect lead) | A public code revision has a high static-asset overlap with the observed page template. | Asset reuse does not identify an author, domain operator, server subscriber, payment-account holder, or natural person. The specific public-account correlation is kept outside this report packet. | Preserve or provide that source only if an investigating authority requests it and after its provenance and limitations are reviewed. |
| `103.149.86.246`, AS149125 / 4S TECHNOLOGY TRADING SERVICES COMPANY LIMITED | Direct Host-header responses served the fake page for `hungdungmedia.fun` and `caothaisonmedia.shop` at the stated times. | The allocation holder is not established as the commercial hoster subscriber or scam operator. A shared /23 is not exclusive to this campaign. | VPS/customer assignment, abuse, and server logs from the network provider through appropriate lawful process. |
| Hostinger Operations, UAB (IANA registrar ID 1636) | RDAP names Hostinger as registrar for the 20 historical roots and both continuations; abuse contact is `abuse@hostinger.com`. | Registrar status does not prove hosting, account ownership, or a shared registrant. A Hostinger response recorded `huuhanstudio.space` as suspended but `shop.huuhanstudio.space` as not hosted on its network. | Registrar registration/order/admin records and preservation of relevant account records through the provider/legal process. |
| Cloudflare | RDAP/DNS snapshots for the reported roots list Cloudflare nameservers; observed Cloudflare A/AAAA values are proxy/edge values. | Cloudflare edge IPs are not the hidden origin and do not identify a customer or operator. | Abuse review plus preservation of DNS/zone/account/Worker/registrar records only if provider records link them to the listed domains. |
| ZaloPay / IMEDIA JSC | One synthetic order's QR and read-only metadata named `IMEDIA JSC`, account `Z397926244101696205`, `app_id=4982`, partner ZaloPay. | This does not prove IMEDIA knowingly participated or identify the merchant/KYC holder; the order expired and no payment occurred. | Merchant onboarding/KYC, account ownership, risk/fraud, order, and settlement records via ZaloPay/IMEDIA and lawful process. |

## 6. Evidence bundle and hash handling

### 6.1 Recommended sanitized attachments

Attach only what the recipient needs. The following files are local repository paths relative to the repository root; they are not public download links.

* `investigation/tiktok/campaign_iocs.csv` — 20-member historical IOC export.
* `investigation/tiktok/campaign_continuations.csv` — two post-cutoff continuation records.
* `investigation/tiktok/law_enforcement_origin_excerpt.json` — sanitized direct-vhost observations and allocation caveat; it omits names, emails, and phone numbers from registry technical/administrative contact records. Do **not** attach `origin_observation.json` or `origin_inventory.json`; those internal files contain contact details.
* `investigation/tiktok/template_fingerprint.json` — normalized HTML method and 32 asset hashes.
* `investigation/tiktok/qr_order_evidence.json` — sanitized payment evidence; transaction token intentionally omitted.
* Use [law_enforcement_evidence_index.md](law_enforcement_evidence_index.md) for the neutral law-enforcement narrative and the verified 22-row URL/time/capture index. Do not attach `public_correlation_current.md`, `source_correlation.json`, or the full `REPORT.md` to a routine report; any public-code correlation is unverified and is not an operator finding.
* Raw HTML/MHTML captures are preserved originals, **not sanitized attachments**. Do not attach them to general forms or ordinary emails. If an authority requests originals, use its secure evidence channel, send only the requested files, and record the transfer. The capture hashes and local-only paths are listed in the evidence index for identification; they are not upload links.

Do **not** attach `login_probes/`, raw `.headers` files, or `zalopay_emv_response.json` by default: some contain temporary cookies or a transaction token. If a provider or law-enforcement investigator specifically requests raw material, send it through their secure upload channel and record exactly what was sent.

### 6.2 Current SHA-256 values (verify again immediately before sending)

The [law-enforcement evidence index](law_enforcement_evidence_index.md) contains the verified current SHA-256 for every available page-capture artifact (19 historical MHTMLs, one continuation MHTML, and one direct response body), the two canonical sanitized IOC exports, the template-fingerprint file, the sanitized origin excerpt, and sanitized payment evidence. Values were recomputed on 2026-10-05; recompute them again if any file is edited, copied, or transmitted. A hash is an integrity check, not proof of collection time or chain-of-custody authenticity.

The canonical [evidence manifest](evidence_manifest.json) was generated on `2026-09-01T13:34:02Z`. Its `REPORT.md` hash/size do not match the current report file and its other entries are not a current verification of later changes. Do not treat it as a current checksum list. Filesystem modification times are not collection timestamps.

## 7. Official reporting routes and factual drafts

The routes below were checked on 2026-10-05 against official pages or preserved first-party/provider records where available. Open the official route before submitting because forms, authentication requirements, and contacts can change. No submission is authorized by this packet.

### 7.1 TikTok — external site impersonation / scam report

**Official route:** TikTok in-app/web “Report a problem,” the current TikTok Safety/Report form at `https://www.tiktok.com/legal/report/feedback?lang=en`, or the support index at `https://support.tiktok.com/`. If a TikTok post, account, ad, or direct message sent the traffic, report that exact object in TikTok and append its URL. Do not invent an account/post URL if none was preserved.

**Submission requirement:** Authentication or contact details may depend on the report route. The user must use their own account when reporting an in-app object and provide truthful contact details/certification if requested. No TikTok account, reporter identity, or contact is prefilled here.

**Draft:**

The [law-enforcement evidence index](law_enforcement_evidence_index.md) contains a neutral summary and a 22-entry URL table. It distinguishes 21 entries with page evidence from the `shop.sonhaimedia.sbs` IOC, which has no campaign-page capture. If reporting to TikTok, provide only the relevant URLs and accurately describe the pages as external sites that presented as TikTok Coins recharge. The captured login form requested a TikTok username/ID only; no password field was present. The client included a prepaid-card submission path, but no real card value is shown as submitted. A documented synthetic order expired with no payment; its QR metadata showed an IMEDIA JSC receiver label through ZaloPay. These facts do not identify the sites' operator or establish that the receiver or any company knowingly participated.

**Suggested evidence:** `campaign_iocs.csv`, `campaign_continuations.csv`, and `template_fingerprint.json`. Do not attach raw MHTML/HTML by default; if TikTok requests an original, use its secure upload path. Add direct TikTok object URLs only from the user's own records.

### 7.2 Cloudflare — abuse/phishing report and preservation request

**Official route:** `https://www.cloudflare.com/abuse/form` (Cloudflare Trust & Safety abuse form). The preserved provider documentation is [origin_sources/cloudflare_report_abuse.md](origin_sources/cloudflare_report_abuse.md).

**Submission requirement:** **User contact required; Cloudflare account login is not assumed.** The submitter must provide their own email/contact and complete any required abuse-form declarations or verification.

**Draft:**

> **Complaint type:** Phishing / impersonation / fraud
>
> I am reporting the following external domains that presented the same Vietnamese TikTok Coins recharge application: [paste the exact URLs from `campaign_iocs.csv` and `campaign_continuations.csv`]. The historical reports span 2026-08-19T08:55:17Z through 2026-09-01T09:05:07Z UTC. Nineteen historical MHTML captures normalize to HTML SHA-256 `f248a056b185e69f5441cd4b9a1eaa705f289109a9b3ab891afe05c4bd17889d` and share 32 static TikTok/payment assets. The pages present TikTok branding, a fake username/session flow, QR payment, and a prepaid-card path that sends `telco`, `amount`, `serial`, and `code` to `/buy`.
>
> The case RDAP/DNS snapshots list Cloudflare nameservers for the reported roots; observed Cloudflare A/AAAA values are treated as proxy/edge values, not origins. Independent read-only Host-header requests reached `103.149.86.246:80` and returned the same fake page for `napxu.hungdungmedia.fun` at 2026-09-01T04:18:16Z and `napxu.caothaisonmedia.shop` at 2026-09-01T11:02:24Z; this does not establish that Cloudflare hosts the origin or that Cloudflare knowingly participated. Please review the reported domains and route the complaint to the responsible customer, registrar, or host as appropriate. If your records show Cloudflare-hosted Workers/Pages or registrar services are involved, review those services under your policy; do not assume that from nameserver/CDN evidence alone. Preserve records within your control for lawful process and do not disclose personal data to the reporter outside your policy.

**Suggested sanitized evidence:** the two IOC CSVs, `law_enforcement_origin_excerpt.json`, and `template_fingerprint.json`. Include `qr_order_evidence.json` only if the payment lead is relevant. Do not attach raw `origin_observation.json`. Do not attach raw HTML/MHTML by default; provide a requested sample through Cloudflare's secure channel. Do not call Cloudflare proxy IPs the origin.

### 7.3 Hostinger — registrar abuse/fraud and preservation request

**Official route:** `abuse@hostinger.com` and the current Hostinger abuse/report form linked from Hostinger's RDAP/abuse pages. The RDAP record for `hungdungmedia.fun` identifies Hostinger Operations, UAB (IANA registrar ID 1636) and `abuse@hostinger.com`.

**Submission requirement:** **User contact required; account authentication may be requested.** Send from the user's own address. If the user has a Hostinger account, use the authenticated abuse/support route only for their own account; do not attempt to access or guess another account.

**Draft email:**

> **Subject:** Coordinated fake TikTok Coins recharge domains — abuse review and evidence preservation request
>
> Hello Hostinger Abuse & Fraud Prevention Team,
>
> I am reporting 22 URL/IOC records in the attached `campaign_iocs.csv` and `campaign_continuations.csv`. Page evidence is available for 21 entries: 19 historical MHTML captures, one continuation MHTML capture, and one direct HTTP response body. The `shop.sonhaimedia.sbs` entry has no campaign-page capture and is included as an unverified related IOC only. The 19 historical MHTML captures normalize to HTML SHA-256 `f248a056b185e69f5441cd4b9a1eaa705f289109a9b3ab891afe05c4bd17889d`; the continuation evidence and per-file hashes are itemized in `law_enforcement_evidence_index.md`.
>
> RDAP identifies Hostinger Operations, UAB as registrar (IANA ID 1636) for the reported roots, while Cloudflare nameservers/proxy addresses were observed. I am not asserting that Hostinger hosted the origin or that any provider knowingly participated. A prior Hostinger response recorded in this case treated `huuhanstudio.space` as suspended but `shop.huuhanstudio.space` as not hosted on Hostinger's network; please review both registrar and hosting roles separately.
>
> Please review the domains under your abuse/fraud policy, suspend or lock them if appropriate, route any hosting complaint to the actual host, and preserve relevant registration, order, account, DNS, and abuse records for lawful process. Please confirm which exact domain(s) you reviewed and whether they are registrar-only, hosted, or neither. Do not disclose registrant personal data to me; if disclosure is legally available, please provide the lawful-process route.
>
> Reporter: `[USER'S NAME]`  
> Contact: `[USER'S EMAIL]`  
> Jurisdiction: `[COUNTRY / STATE / CITY]`

**Suggested evidence:** the IOC CSVs and a concise hash list. Do not attach raw RDAP/contact records, the full origin inventory, or prior correspondence by default; provide a specific item only if Hostinger requests it through an appropriate channel.

### 7.4 Network/allocation abuse route — VNNIC IRT / APNIC routing

**Official contact recorded in the APNIC WHOIS evidence:** `hm-changed@vnnic.vn` is listed for the `103.149.86.0/23` abuse contact; the local APNIC snapshot also names IRT-VNNIC-AP. This is a network/allocation abuse route, **not proof that VNNIC or 4S Technology is the commercial hoster**. `103.149.86.246:80` directly served two reported Host headers at the stated times; the actual server customer/hoster remains unknown. `103.149.87.34` is a separate historical related endpoint, not a current campaign origin.

**Submission requirement:** The reporter should use their own reply-capable email and actual name if requested. No RIR/network account login is assumed. Do not include the APNIC technical/admin person's details or address the individual; the formal IRT abuse mailbox is sufficient.

**Short factual report draft:**

> I am reporting suspected abuse involving `103.149.86.246:80` and requesting that you route this notice to the actual network/hosting provider. Direct read-only HTTP GET requests with Host headers `napxu.hungdungmedia.fun` at `2026-09-01T04:18:16Z` and `napxu.caothaisonmedia.shop` at `2026-09-01T11:02:24Z` returned HTTP 200 Vietnamese TikTok Coins recharge pages. The respective body SHA-256 values are `a0e74fe2c82e1c9dd46d9ec89428f9253a8d8671ec909272d5b50289f46f1be7` and `2659d10a2db6bf1ad56766f89767a3054f2defb7271a089678f2f1efadc7eee3`. APNIC registry data associate the address with `103.149.86.0/23`, AS149125, registered to 4S Technology; this does not establish the commercial hoster, subscriber, or operator. Please identify the appropriate abuse contact/provider, preserve any relevant records within your control for lawful process, and consider targeted action against the specific vhost/customer after preserving evidence. Do not suspend the whole shared address or prefix based only on this report. No payment or real credentials were submitted. Please provide a case reference and the appropriate secure channel for requested evidence.
>
> Reporter: `[USER'S NAME / EMAIL]`

The longer bilingual draft in `apnic_vnnic_takedown_email.txt` contains jurisdiction-specific legal assertions and requests beyond this factual notice; **do not forward it unchanged** without an independent current-law review.

### 7.5 ZaloPay / Công ty cổ phần Zion — payment-risk report

**Official route:** use the current ZaloPay Help/Support/Report-fraud route from `https://zalopay.vn/`. On 2026-10-05 the official site exposed the customer-service hotline `1900 545 436` and the security-report address `reportcs@zalopay.vn`; verify the live page before sending because contacts can change.

**Submission requirement:** **User contact required for follow-up; no account login is assumed.** The user must supply their own contact details. Do not submit another person's identity or claim to be the account holder.

**Draft:**

> **Subject:** Fraud-risk review of ZaloPay QR receiver shown by fake TikTok recharge sites
>
> I am reporting a payment-risk indicator from a coordinated set of external sites impersonating TikTok Coins recharge. On 2026-09-01 at 02:35 UTC, a read-only synthetic username probe created order 7052 for VND 50,000 (displayed pay amount VND 48,500). The generated QR and a read-only dynamic-QR metadata lookup both identified:
>
> * receiver name: `IMEDIA JSC`
> * receiver account: `Z397926244101696205`
> * ZaloPay `app_id`: `4982`
> * partner: ZaloPay / Công ty cổ phần Zion
>
> The QR metadata set expiry to 2026-09-01T02:49:59Z; the final status check at 2026-09-01T04:06:01Z returned `expired`. No payment was made. The saved QR/order response is associated in the case timeline with the `napxu.hungdungmedia.fun` origin capture, but the response artifact itself does not record a request URL or Host header. It therefore does not independently prove that this receiver appeared on every campaign domain or on `napxu.caothaisonmedia.shop`. Please use the order/account details to cross-check your records; I am not alleging that ZaloPay or IMEDIA knowingly participated, and I am not asserting that the receiver account holder is the website operator.
>
> Please conduct a fraud/merchant-risk review, preserve merchant onboarding/KYC, account-linkage, order, risk, and settlement records associated with `app_id=4982` / the receiver account for lawful process, and advise the correct official process for an investigator or victim to submit additional evidence. Please do not disclose account-holder personal data to me outside your policy.
>
> Reporter: `[USER'S NAME]`  \
> Contact: `[USER'S EMAIL]`

**Suggested evidence:** `qr_order_evidence.json` and the single confirmed campaign URL only if the user verifies it against the capture context. Do not imply that the receiver was observed on all IOCs. Do not attach raw `zalopay_emv_response.json` because it contains a transaction token; if raw material is requested, use a secure channel.

### 7.6 IMEDIA JSC — merchant/brand clarification and fraud-risk report

**Official route:** use the official iMedia site/contact page at `https://imediatech.com.vn/` or the public contact captured from iMedia's own site/API. The preserved public material identifies `CÔNG TY CỔ PHẦN CÔNG NGHỆ VÀ DỊCH VỤ IMEDIA` / `IMEDIA TECHNOLOGY AND SERVICES JOINT STOCK COMPANY`, registration/tax identifier `0105837941`, and `info@imediatech.com.vn`; verify the current recipient before sending. Do not use a third-party directory as the sole contact source.

**Submission requirement:** **User contact required for follow-up; no IMEDIA account authentication is assumed.**

**Draft:**

> **Subject:** Please review IMEDIA-labelled receiver used by fake TikTok recharge pages
>
> Hello IMEDIA security/fraud or compliance team,
>
> I am reporting a payment receiver label that appeared in a fake Vietnamese TikTok Coins recharge flow. A read-only synthetic order created on 2026-09-01 at 02:35 UTC returned a ZaloPay QR naming `IMEDIA JSC`, receiver account `Z397926244101696205`, and `app_id=4982`; a read-only ZaloPay lookup corroborated the same receiver label. The QR metadata set expiry to 2026-09-01T02:49:59Z; the final status check at 2026-09-01T04:06:01Z returned `expired`, and no payment was made.
>
> The surrounding pages impersonated TikTok, used the title `Nạp xu TikTok`, and exposed QR/card collection routes. The exact domains and hashes are preserved in the local IOC exports; provide only the relevant records through the recipient's accepted channel. I am **not** alleging that IMEDIA operated the pages or knowingly participated. Please confirm through your fraud/compliance process whether this receiver was authorized, flag or suspend it if appropriate under your policy, preserve merchant/KYC/order/settlement records for lawful process, and provide the correct channel for an affected customer or law-enforcement request.
>
> Reporter: `[USER'S NAME]`  \
> Contact: `[USER'S EMAIL]`

**Suggested evidence:** `qr_order_evidence.json` and a concise description of the observed campaign page. Include only the specific URL if independently confirmed from the request record. Avoid unrelated company records or personal data.

### 7.7 FTC — consumer fraud report (United States)

**Official route:** `https://reportfraud.ftc.gov/` (FTC ReportFraud). Use only if the reporter is in the United States or is reporting a US consumer/business impact; otherwise use the appropriate local consumer-protection authority.

**Submission requirement:** No login is assumed by the public report route; check the live form for required fields. Provide the user's own contact details if requested, and distinguish an observer report from a victim report. This packet records no US victim or financial loss.

**Draft narrative:**

Use the neutral narrative in [law_enforcement_evidence_index.md](law_enforcement_evidence_index.md), adapting it to the submitter's actual role and the current FTC form. Describe the 22 IOC records as reported URLs, not 22 captured pages; disclose that one IOC has no campaign-page capture. The evidence shows page presentation and a client-side card-submission path, not that prepaid-card values were actually received. The documented synthetic order expired without payment. Do not claim a personal loss or identify an operator unless the submitter has independent, verifiable evidence.

If the user or another known victim lost money, append the victim's own transaction date, amount, bank/payment receipt, and contact information only with that person's authorization. Do not invent a loss.

### 7.8 FBI IC3 — cyber-enabled crime complaint (United States)

**Official route:** `https://www.ic3.gov/` → “File a report” → the official complaint form at `https://complaint.ic3.gov/`. Use the user's own identity and jurisdiction; do not submit on behalf of another person without authorization.

**Submission requirement:** The user must provide their own information and certify accuracy where requested. Answer any complainant/victim, loss, and contact fields truthfully; do not claim to be a victim or file for an unidentified person. IC3 advises not to attach files; retain originals locally and submit them only if an investigating authority later requests them through a secure channel.

**Draft complaint summary:**

Use the neutral narrative in [law_enforcement_evidence_index.md](law_enforcement_evidence_index.md) as a starting point, not as a substitute for the complainant's own truthful account. The current IC3 form requires a complainant/contact and an accuracy certification; the form and FAQ state that IC3 does not accept attachments, and the FAQ states IC3 does not conduct investigations or provide status updates. Do not claim the submitter is a victim or enter details for an unidentified affected person. If there is no known affected complainant, report the suspected observations to the appropriate local police route and follow that agency's intake guidance; do not invent victim, loss, or operator details.

If an actual victim exists, add only that victim's authorized details, loss, transaction IDs, and communications. Do not include unrelated temporary cookies or raw payment tokens.

### 7.9 Local law enforcement / cybercrime unit

**Official route:** use the official police reporting process in the submitter's actual jurisdiction. No user jurisdiction or victim location is established by this evidence, so this packet does not select a particular police force. If in Germany, the official state-police online-reporting portal is `https://portal.onlinewache.polizei.de/`; otherwise use the local police/cybercrime unit's official site or non-emergency process. For immediate danger, use the local emergency process.

**Submission requirement:** A formal report may request the user's identity/contact and jurisdiction; anonymous-tip and verification rules vary by agency. The user must provide only facts within their knowledge. An officer may request original files through a secure channel.

**Draft incident statement:**

> Use the neutral narrative in [law_enforcement_evidence_index.md](law_enforcement_evidence_index.md), adapting the submitter role and facts to what they personally know. The evidence index lists 22 reported URL/IOC records, but only 21 have preserved page content; `shop.sonhaimedia.sbs` is explicitly marked unverified. It includes the exact URLs, submission IDs, UTC and registration timestamps, per-capture hashes, the direct-vhost observations, and a sanitized origin excerpt. The payment order expired without payment; the IMEDIA-labelled receiver is a lead only. No named person or public account is identified as the operator.
>
> Ask the receiving police authority how to transfer original MHTML/HTML through an approved secure channel and whether it can preserve or lawfully obtain relevant registrar, hosting, server, platform-referral, or payment records. Do not attach internal files containing reporter/network metadata, session-like values, or payment tokens. Police decide whether a case, preservation request, or further action is appropriate.
> Reporter: `[USER'S NAME]`  \
> Contact: `[USER'S CONTACT]`  \
> Location/jurisdiction: `[COUNTRY / STATE / CITY]`  \
> Known victim/loss: `[NONE / USER-SUPPLIED FACTS ONLY]`

## 8. Existing route status and “initiate” boundary

The local evidence shows that earlier workflows already recorded some provider-route activity: several Hostinger and Google Safe Browsing reports were sent in August 2026; for the two post-cutoff continuations, the snapshot at `2026-09-01T13:00:42.456Z` recorded Hostinger awaiting a provider reply for `aoanh`, Cloudflare routes running, and Google Safe Browsing/Netcraft submitted. These are workflow statuses, not proof of provider action, identity, or takedown. This packet **does not send a new report, email, form, or post** and does not claim that any draft below has been received.

## 9. Final pre-submission checklist

- [ ] Add the user's own name/contact/jurisdiction where required; leave unrelated people blank.
- [ ] Use `law_enforcement_evidence_index.md` as the exact 22-record index. State clearly that only 21 entries have content captures and `shop.sonhaimedia.sbs` is unverified.
- [ ] Re-check every URL and timestamp against the current preserved CSV exports.
- [ ] Recompute SHA-256 for every attachment immediately before sending.
- [ ] Attach sanitized derivatives only; do not send cookies, tokens, credentials, or unrelated raw code.
- [ ] Keep the direct-origin caveats: Cloudflare edges are not origins; apex A records are not direct vhost proof; APNIC/4S is an allocation role; Hostinger is registrar evidence, not hosting proof; IMEDIA is a payment receiver label, not a perpetrator finding.
- [ ] Do not include personal network-contact details from `origin_observation.json`, raw submission metadata, or any unrelated Phishing Support reporter information.
- [ ] Do not name any public lead, provider, business, or private person as “the scammer” or operator without authority-held evidence.
- [ ] Save provider confirmation IDs and replies in a private action log; do not publish them.
- [ ] For any request for registrant/KYC/account records, ask for the provider's legal-process channel rather than attempting to obtain private data directly.
