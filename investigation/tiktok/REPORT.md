# TikTok recharge campaign — attribution and evidence report

> **Assessment status:** final investigative synthesis; not a legal finding and not an identification of a perpetrator.
> **Prepared (UTC):** 2026-09-01T05:37:27Z
> **Evidence cutoff (UTC):** 2026-09-01T04:48:58Z
> **Case label:** `tiktok-recharge-campaign`
> **Repository scope:** investigation documentation only; no production application code was changed.

## Executive conclusion

This investigation identifies a **coordinated Vietnamese-language fake TikTok Coins recharge campaign** comprising **20 verified domains/subdomains** reported between **2026-08-19T08:55:17Z and 2026-08-31T18:22:24Z**. Nineteen of the twenty campaign pages have preserved MHTML captures; `shop.sonhaimedia.sbs` is retained as an IOC but has no MHTML artifact. The captured pages have one normalized HTML fingerprint and 32 byte-identical TikTok image/SVG assets across all 19 captures. The pages present TikTok branding, coin bundles, a fake login gate, prepaid-card fields, and bank-transfer QR payment.

The strongest technical lead is the serving origin **`103.149.86.246`**. On 2026-09-01, an HTTP request sent directly to that address with `Host: napxu.hungdungmedia.fun` returned the 186,877-byte fake recharge page (`Apache`, HTTP 200). APNIC/RIR data place the address in **103.149.86.0/23, AS149125 (`DV4S-VN`)**, registered to **4S TECHNOLOGY TRADING SERVICES COMPANY LIMITED** in Vietnam. This is a **network/hosting attribution**, not proof that 4S Technology or its listed contacts operated the fraud.

A single **synthetic/public-user** probe (username `tiktok`, amount VND 50,000) obtained order **7052** without paying. The generated EMVCo QR named **IMEDIA JSC** as receiver, account **`Z397926244101696205`**, and resolved through ZaloPay metadata as **`app_id=4982`**. The order was later reported `expired`; no payment, card value, password, OTP, or private credential was submitted. This is a strong **payment-account lead**, not proof of who controlled the account or whether IMEDIA knowingly participated.

The public `taiapi` / `gaudev` / “Gấu” material is a **low-to-medium confidence investigative lead**: it shows a Vietnamese developer persona publishing unrelated Play Together/VNG bot code with generic ZaloPay/VietQR routines and cross-platform aliases. No fake-shop domain, origin IP, payment account, exact code fingerprint, or operator credential links that persona to this campaign. The **actual perpetrator identity remains unresolved**.

### Attribution at a glance

| Question | Confidence | What the evidence supports | What it does **not** support |
|---|---|---|---|
| Are these sites one campaign/kit? | **High** | 20 related IOCs, shared wording/flow, one normalized HTML fingerprint across 19 captures, 32 shared static assets, repeated Cloudflare/Hostinger pattern. | The legal identity of the author or operator. |
| Which host served the live application? | **High** | Direct Host-header request to 103.149.86.246 returned the fake page; ten apexes also exposed that address in the 2026-09-01 authoritative snapshot. | That the network registrant authored or knew about the content. |
| Which payment destination was shown? | **High** | Order 7052 and read-only ZaloPay lookup agree on IMEDIA JSC / account Z397926244101696205 / app 4982. | The KYC customer, beneficial owner, or knowledge/intent of IMEDIA. |
| Is IMEDIA JSC the scammer? | **Not established** | IMEDIA is a real telecom/digital-goods/payment intermediary and publicly warns about impersonation. | Any knowing involvement; no such evidence was found. |
| Is `taiapi` / `gaudev` the operator? | **Low–medium lead only** | Public aliases, code credits, and matching public avatars form a coherent persona cluster. | A technical or financial link to this campaign. |
| Who is the perpetrator? | **Unresolved** | Further provider records and lawful process are needed. | A defensible individual attribution from current evidence. |

## Scope, method, and safety boundaries

### Collection scope

* Phishing-support submissions and immutable artifact metadata (`artifacts_tiktok.csv`, `provider_reports_tiktok.csv`, and `report_threads_tiktok.csv`).
* Read-only HTTP retrievals, direct virtual-host checks, DNS and authoritative DNS queries, RDAP/APNIC/RIPEstat records, and a passive Shodan service record.
* Static HTML/JavaScript/MHTML comparison and extraction of client-side routes and data fields.
* Public corporate pages/API responses for IMEDIA; public GitHub, Facebook, and TikTok profile material for a candidate lead.
* A read-only ZaloPay dynamic-QR metadata lookup for the captured QR payload.

### Explicit safety limits

* Exactly one synthetic/public-user QR order was created to identify the payment destination. **No payment was made**, and the order expired.
* No real TikTok credentials, passwords, OTPs, payment-card details, prepaid-card serials/PINs, or private account data were entered.
* The `/buy` endpoint was **not** called with card values. Its data path is established from the captured JavaScript only.
* No SSH authentication was attempted against the origin; no brute force, traversal, Cloudflare bypass, or intrusive scanning was performed.
* Temporary cookies, ZaloPay transaction tokens, and credential-like strings found in unrelated public code are retained only in local evidence where necessary and are not reproduced here or committed.

## Collection timeline (UTC)

This timeline records the principal acquisition and preservation events. The source files named here are indexed, hashed, and sensitivity-labeled in `evidence_manifest.json`; filesystem modification times are not substituted for source-provided HTTP/RDAP timestamps.

| UTC | Event | Primary source |
|---|---|---|
| 2026-08-19T08:55:17Z | First verified campaign submission (`napxu.gnshop.fun`) received; first MHTML artifact created at 08:55:29Z. | `domain_timeline.csv`, `artifacts_tiktok.csv` |
| 2026-08-31T18:22:24Z | Latest verified campaign submission (`napxu.hungdungmedia.fun`) received; MHTML artifact created at 18:22:37Z. | `domain_timeline.csv`, `artifacts_tiktok.csv` |
| 2026-09-01T02:24:48Z | Direct-IP HTTP capture returned the TikTok page from the origin vhost. | `live-direct-ip.txt` |
| 2026-09-01T02:34:59Z–02:35:00Z | Synthetic/public `tiktok` login and order 7052 QR response captured. | `probe_qr_response.txt`, `live_final_direct.html` |
| 2026-09-01T03:25:35Z | Read-only ZaloPay dynamic-QR metadata lookup returned app 4982 and IMEDIA receiver. | `zalopay_emv.headers`, `zalopay_emv_response.json` |
| 2026-09-01T03:37:56Z–03:38:03Z | Safe public-ID login probes returned profile/session responses; no passwords supplied. | `login_probes/` (local-only) |
| 2026-09-01T03:39:25Z–03:39:29Z | Non-existent origin paths returned Apache/`404 page not found` responses. | `origin_probe/` (local-only) |
| 2026-09-01T03:44:24Z | APNIC RDAP captured the 103.149.86.0/23 network registration. | `apnic_rdap.json` |
| 2026-09-01T03:46:52Z–03:47:01Z | Direct subdomain vhost sweep recorded 18 default pages, one error, and the live fake page. | `vhost_checks.jsonl` |
| 2026-09-01T04:16:38Z–04:17:55Z | Public DNS, authoritative DNS, and apex vhost snapshots captured. | `dns_snapshot*.json`, `apex_vhost_checks.json` |
| 2026-09-01T04:18:16Z–04:19:03Z | Final direct-origin response, DNS split, and `hungdungmedia.fun` RDAP hold state captured. | `live_final_direct.*`, `live_final_dns.txt`, `rdap_hungdung_final2.json` |
| 2026-09-01T04:38:27Z | RIPEstat network/WHOIS lookups refreshed. | `ripestat_network_info.json`, `ripestat_whois.json` |
| 2026-09-01T04:48:58Z | Related `napthetiktok.online` RDAP snapshot captured; this is the evidence cutoff for this report. | `related_sites/napthetiktok_rdap.json` |

## Verified campaign IOCs

The following table is the 20-member campaign inventory. `Origin at snapshot` means the address `103.149.86.246` appeared in the authoritative DNS snapshot at `2026-09-01T04:17:17Z`, or the direct Host-header test proved the same origin for `napxu.hungdungmedia.fun`. The vhost column is a **point-in-time** check at approximately `2026-09-01T03:46:52Z–03:47:01Z`; a default page or error does not erase the historical phishing evidence.

| # | Host | Root | Submission | Registered (UTC) | Nameserver pair in RDAP | Origin at snapshot | Vhost check |
|---:|---|---|---:|---|---|---|---|
| 1 | `nap-xu-247.vntik.shop` | `vntik.shop` | 348421337477287968 | 2026-03-19T08:53:11.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | — | default nginx (200) |
| 2 | `napxu.gnshop.fun` | `gnshop.fun` | 348389447261229079 | 2026-06-14T01:58:58.733Z | saanvi.ns.cloudflare.com/decker.ns.cloudflare.com | — | default nginx (200) |
| 3 | `napxu247.muanhanh.shop` | `muanhanh.shop` | 348539296447205417 | 2026-08-14T06:59:47.0Z | marty.ns.cloudflare.com/serena.ns.cloudflare.com | — | default nginx (200) |
| 4 | `napxunhanhre.khuyenmai2026.site` | `khuyenmai2026.site` | 348866265474928698 | 2026-08-14T07:00:08.739Z | marty.ns.cloudflare.com/serena.ns.cloudflare.com | — | default nginx (200) |
| 5 | `napxu.dltiktik.shop` | `dltiktik.shop` | 348756442276171825 | 2026-08-19T16:47:26.0Z | marty.ns.cloudflare.com/serena.ns.cloudflare.com | — | default nginx (200) |
| 6 | `nap-xu.sky1media.shop` | `sky1media.shop` | 350078878372335632 | 2026-08-20T23:32:40.0Z | marty.ns.cloudflare.com/serena.ns.cloudflare.com | — | default nginx (200) |
| 7 | `napxu.takimedia.shop` | `takimedia.shop` | 349031076745711685 | 2026-08-20T23:38:28.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | — | default nginx (200) |
| 8 | `nap-xu.thuynmedia.shop` | `thuynmedia.shop` | 350354710311473187 | 2026-08-24T16:39:51.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | — | default nginx (200) |
| 9 | `napxu.thuytongstore.fun` | `thuytongstore.fun` | 350466798270812200 | 2026-08-25T01:56:00.327Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 10 | `shop-xu.kimsonmedia.sbs` | `kimsonmedia.sbs` | 350930905994367026 | 2026-08-26T07:43:44.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 11 | `shop.sonhaimedia.sbs` | `sonhaimedia.sbs` | 351624943487684609 | 2026-08-26T08:32:50.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 12 | `shop.huuhanstudio.space` | `huuhanstudio.space` | 351387190816673794 | 2026-08-27T08:20:21.125Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 13 | `shop.dainammedia.space` | `dainammedia.space` | 352185586284498946 | 2026-08-29T14:16:28.648Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 14 | `napxu.hoanghaimedia.shop` | `hoanghaimedia.shop` | 352342673387950094 | 2026-08-30T05:07:45.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 15 | `napxu.ko-media.art` | `ko-media.art` | 352730056440680448 | 2026-08-31T07:11:30.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 16 | `shop.hd-media.space` | `hd-media.space` | 352784145123905536 | 2026-08-31T07:27:16.097Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 17 | `napxu.quangthaimedia.shop` | `quangthaimedia.shop` | 352799328705712141 | 2026-08-31T08:45:28.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 18 | `napxu.quanghung-media.site` | `quanghung-media.site` | 352832125797404695 | 2026-08-31T08:57:14.830Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | — | 503/error |
| 19 | `napxu.hoanganhmedia.sbs` | `hoanganhmedia.sbs` | 352854759947898915 | 2026-08-31T14:16:48.0Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | default nginx (200) |
| 20 | `napxu.hungdungmedia.fun` | `hungdungmedia.fun` | 352880825026482223 | 2026-08-31T14:26:14.609Z | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com | 103.149.86.246 | fake page (200) |

Machine-readable exports are in [`campaign_iocs.json`](campaign_iocs.json) and [`campaign_iocs.csv`](campaign_iocs.csv). The related lead `napthetiktok.online` is intentionally **not** counted as a verified campaign member; see [Related lead](#related-lead-napthetiktokonline).

## What the pages do

### Brand impersonation and lure

Every captured page uses Vietnamese TikTok recharge language including:

* title and heading **`Nạp xu TikTok`** / **`Nạp xu TikTok - Trung tâm nạp xu TikTok`**;
* TikTok-style logo, coin icon, navigation/help links, and “Thanh toán bảo mật” trust cues;
* eight visible bundles from **350 coins / VND 50,000** through **35,000 coins / VND 5,000,000**;
* “save about 25%” language and a first-recharge **+50%** promotion from 2,100 coins;
* Visa, MoMo, VNPay, ZaloPay, ZingPay, Viettel, Mobifone, Vinaphone, and Garena payment logos.

The official TikTok purchase URL is `https://www.tiktok.com/coin`; none of the campaign hosts is a TikTok-owned domain. The copied branding and payment flow therefore constitute high-confidence TikTok impersonation regardless of whether a particular backend transaction completed.

### Login behavior — important qualification

The login modal asks only for a **TikTok ID/username**. The captured HTML explicitly says (translated): “We do not require users to provide a password.” The client sends a multipart `POST /login` containing `username`; safe probes with public IDs received profile fields and a temporary session. **No password field was present in the captured form and no password was tested.** The evidence therefore demonstrates account-ID enumeration/session creation and payment fraud risk, but does **not** prove TikTok-password theft by this page.

### Payment/card behavior

The client exposes these routes:

```text
POST /login
POST /qr_order
GET  /qr_status?order_id=...
POST /buy
GET  /cards
POST /logout
```

For the phone/game-card path, the page asks the user to select a telco and enter **Mã thẻ** (card code) and **Số seri** (serial). The JavaScript constructs `FormData` with exactly `telco`, `amount`, `serial`, and `code`, then sends it to `POST /buy`. The read-only `GET /cards` response returned six providers: `GARENA`, `VIETTEL`, `VINAPHONE`, `MOBIFONE`, `ZING`, and `VCOIN`.

This is direct evidence of an intended prepaid-card collection/processing path. It is deliberately reported as **intended transmission** rather than a claim that a real card value was harvested during this investigation.

### Deliberate fake-order branch

The inline client code contains a whitelist branch with comments that translate to “create a fake order in the client; do not call `/qr_order`.” It generates a random account number, labels the receiver `XPAY`, skips QR polling, and reports local success after a delay. Normal users are sent through the real `/qr_order` and `/buy` paths. This source-level branch is evidence of an intentionally deceptive demo/allowlist path; it does not by itself identify the author.

## Template correlation

The 19 captured campaign MHTML pages were compared after a deliberately narrow normalization: UTF-8 decode, lowercase, replace absolute URLs with `HOST`, replace `cid:` references with `CID`, collapse whitespace, and hash the resulting comparison string. All 19 produced:

```text
normalized HTML bytes: 16276
normalized HTML SHA-256: f248a056b185e69f5441cd4b9a1eaa705f289109a9b3ab891afe05c4bd17889d
```

The original MHTML files have different byte hashes because each capture contains a different host, MIME boundaries, and capture metadata. The normalized equality is stronger than a visual similarity claim while avoiding the false assertion that the raw files are byte-identical. The 20th campaign member (`shop.sonhaimedia.sbs`) has no MHTML artifact and is not included in this equality test.

The derived fingerprint table records **32** byte-identical assets under `/public/images/tiktok/` in all 19 captures. Examples include:

```text
/public/images/tiktok/card/garena.png
/public/images/tiktok/card/mobifone.png
/public/images/tiktok/card/vcoin.png
/public/images/tiktok/card/viettel.png
/public/images/tiktok/card/vinaphone.png
/public/images/tiktok/card/zing.png
/public/images/tiktok/method/method_garena.png
/public/images/tiktok/method/method_mobifone.png
/public/images/tiktok/method/method_momo.png
/public/images/tiktok/method/method_viettel.png
/public/images/tiktok/method/method_vinaphone.png
/public/images/tiktok/method/method_visa.png
```

See [`template_fingerprint.json`](template_fingerprint.json) for every captured MHTML hash, submission ID, normalization method, and asset hash.

## Registration and DNS timeline

### Registration sequence

The registration records (all 20 roots) are summarized below. Dates come from root-domain RDAP; blank or conflicting historical DNS values are not filled by inference.

| Registration (UTC) | Root | Host | Submission | Nameservers |
|---|---|---|---:|---|
| 2026-03-19T08:53:11.0Z | `vntik.shop` | `nap-xu-247.vntik.shop` | 348421337477287968 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-06-14T01:58:58.733Z | `gnshop.fun` | `napxu.gnshop.fun` | 348389447261229079 | saanvi.ns.cloudflare.com/decker.ns.cloudflare.com |
| 2026-08-14T06:59:47.0Z | `muanhanh.shop` | `napxu247.muanhanh.shop` | 348539296447205417 | marty.ns.cloudflare.com/serena.ns.cloudflare.com |
| 2026-08-14T07:00:08.739Z | `khuyenmai2026.site` | `napxunhanhre.khuyenmai2026.site` | 348866265474928698 | marty.ns.cloudflare.com/serena.ns.cloudflare.com |
| 2026-08-19T16:47:26.0Z | `dltiktik.shop` | `napxu.dltiktik.shop` | 348756442276171825 | marty.ns.cloudflare.com/serena.ns.cloudflare.com |
| 2026-08-20T23:32:40.0Z | `sky1media.shop` | `nap-xu.sky1media.shop` | 350078878372335632 | marty.ns.cloudflare.com/serena.ns.cloudflare.com |
| 2026-08-20T23:38:28.0Z | `takimedia.shop` | `napxu.takimedia.shop` | 349031076745711685 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-24T16:39:51.0Z | `thuynmedia.shop` | `nap-xu.thuynmedia.shop` | 350354710311473187 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-25T01:56:00.327Z | `thuytongstore.fun` | `napxu.thuytongstore.fun` | 350466798270812200 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-26T07:43:44.0Z | `kimsonmedia.sbs` | `shop-xu.kimsonmedia.sbs` | 350930905994367026 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-26T08:32:50.0Z | `sonhaimedia.sbs` | `shop.sonhaimedia.sbs` | 351624943487684609 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-27T08:20:21.125Z | `huuhanstudio.space` | `shop.huuhanstudio.space` | 351387190816673794 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-29T14:16:28.648Z | `dainammedia.space` | `shop.dainammedia.space` | 352185586284498946 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-30T05:07:45.0Z | `hoanghaimedia.shop` | `napxu.hoanghaimedia.shop` | 352342673387950094 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-31T07:11:30.0Z | `ko-media.art` | `napxu.ko-media.art` | 352730056440680448 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-31T07:27:16.097Z | `hd-media.space` | `shop.hd-media.space` | 352784145123905536 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-31T08:45:28.0Z | `quangthaimedia.shop` | `napxu.quangthaimedia.shop` | 352799328705712141 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-31T08:57:14.830Z | `quanghung-media.site` | `napxu.quanghung-media.site` | 352832125797404695 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-31T14:16:48.0Z | `hoanganhmedia.sbs` | `napxu.hoanganhmedia.sbs` | 352854759947898915 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |
| 2026-08-31T14:26:14.609Z | `hungdungmedia.fun` | `napxu.hungdungmedia.fun` | 352880825026482223 | decker.ns.cloudflare.com/saanvi.ns.cloudflare.com |

Notable near-batches:

* `muanhanh.shop` at `06:59:47Z` and `khuyenmai2026.site` at `07:00:08.739Z` on 2026-08-14 — **21.739 seconds apart**.
* `sky1media.shop` at `23:32:40Z` and `takimedia.shop` at `23:38:28Z` on 2026-08-20 — **5 minutes 48 seconds apart**.
* `kimsonmedia.sbs` and `sonhaimedia.sbs` on 2026-08-26 — **49 minutes 06 seconds apart**.
* `ko-media.art` and `hd-media.space` on 2026-08-31 — **15 minutes 46.097 seconds apart**.
* `quangthaimedia.shop` and `quanghung-media.site` on 2026-08-31 — **11 minutes 46.830 seconds apart**.
* `hoanganhmedia.sbs` and `hungdungmedia.fun` on 2026-08-31 — **9 minutes 26.609 seconds apart**.

All 20 roots resolve in RDAP to **HOSTINGER operations, UAB (IANA registrar ID 1636)**. The early/alternate nameserver pair was `marty.ns.cloudflare.com` / `serena.ns.cloudflare.com`; the dominant later pair was `decker.ns.cloudflare.com` / `saanvi.ns.cloudflare.com`. Batched registration is consistent with automated provisioning or a shared operator workflow, but it does not prove one registrant account or one person.

### DNS and vhost state

At `2026-09-01T04:17:17Z`, the authoritative snapshot returned `103.149.86.246` for these ten roots:

```text
thuytongstore.fun
kimsonmedia.sbs
huuhanstudio.space
sonhaimedia.sbs
dainammedia.space
hoanghaimedia.shop
ko-media.art
hd-media.space
quangthaimedia.shop
hoanganhmedia.sbs
```

The public DNS snapshot at `2026-09-01T04:16:38Z` showed a mix of Cloudflare edge addresses, no answer/delegation, and the direct origin. This is why a Cloudflare address in an initial report must not be treated as the origin. The point-in-time vhost checks found **16 apex hosts on a default nginx page and 4 apex hosts returning a Vietnamese suspension/503 response**. At the subdomain level, **18 returned the same default page, one returned an HTTP 503/error, and `napxu.hungdungmedia.fun` returned the fake page**.

## Origin and network attribution

### Direct origin observation

The `respond5` host was only the investigator’s collection environment; it is not the origin identified below. At `2026-09-01T04:18:16Z`, the following direct virtual-host request returned the phishing page:

```text
GET / HTTP/1.1
Host: napxu.hungdungmedia.fun
Destination: 103.149.86.246:80
HTTP/1.1 200 OK
Server: Apache
Content-Type: text/html; charset=utf-8
Body: 186877 bytes
SHA-256: a0e74fe2c82e1c9dd46d9ec89428f9253a8d8671ec909272d5b50289f46f1be7
```

Equivalent direct probes for non-existent application paths returned the plain body **`404 page not found`** with Apache headers. That error style is compatible with a Go/net/http application, but it is not a unique framework or operator fingerprint.

Shodan’s service record (scan `2026-08-29T15:35:55Z`) listed only TCP **22 (OpenSSH 8.9p1 Ubuntu 3)** and **80 (Apache httpd)**. The SSH banner/host key is not reproduced, and no authentication was attempted.

### RIR/ASN record

APNIC RDAP for `103.149.86.246` (captured `2026-09-01T03:44:24Z`) reports:

```text
Prefix:       103.149.86.0/23
ASN:          AS149125
Netname:      DV4S-VN
Organization: 4S TECHNOLOGY TRADING SERVICES COMPANY LIMITED
Country:      VN
Address:      Thanh Cong Village, Tien Phong Commune,
              Yen Dung District, Bac Giang Province, Vietnam
```

The public technical/administrative contact in the RDAP record is **Tran Duc Quan** (`TDQ9-AP`), phone `+84-986648126`, email `info@congnghe4s.com`; the APNIC incident-routing contact is `hm-changed@vnnic.vn`. These are appropriate preservation/abuse-routing leads only. A network owner can host customer content without authoring or knowing about it.

## Payment-account evidence

### Synthetic order 7052

The captured response for a 50,000 VND bundle was:

| Field | Value |
|---|---|
| Order | `7052` |
| Requested / total | VND 50,000 |
| Pay amount | **VND 48,500** |
| Discount | VND 1,500 (3%) |
| Bank label | `Công ty cổ phần Zion` |
| Receiver | **`IMEDIA JSC`** |
| Account | **`Z397926244101696205`** |
| QR expiry | `2026-09-01T09:49:59+07:00` (`2026-09-01T02:49:59Z`) |
| Final status | `expired` at `2026-09-01T04:06:01Z` |

The EMVCo payload had a valid CRC16/CCITT-FALSE of **`F047`**. A read-only ZaloPay dynamic-QR metadata lookup at `2026-09-01T03:25:35Z` independently returned:

```text
app_id:          4982
amount:          48500
receiver_name:   IMEDIA JSC
receiver_acc:    Z397926244101696205
partner:         2 (Zalopay / Công ty cổ phần Zion)
```

The full payload and source-artifact hashes are preserved in [`qr_order_evidence.json`](qr_order_evidence.json) and cross-indexed in `evidence_manifest.json`. The raw response also contained a temporary transaction token; it is intentionally absent from the derivative and this report. **No payment was made.**

### Control experiment — generic payment bundle is not attribution

The bundled generic ZaloPay/VietQR code contains an example account `Z397926202100439920`. A valid EMV payload built from that generic template resolved read-only to `app_id=4699`, receiver `XPAY`, and that different account. This control result shows that the payment JavaScript bundle is generic/reused; it must not be used to attribute the live campaign to XPAY, IMEDIA, or any code publisher.

## IMEDIA JSC: intermediary caveat

Official iMedia pages/API responses identify:

```text
CÔNG TY CỔ PHẦN CÔNG NGHỆ VÀ DỊCH VỤ IMEDIA
Tax ID: 0105837941
Address: Tầng 5, iMedia Tower, 508 Trường Chinh, Hanoi
Email: info@imediatech.com.vn
Phone: (+84) 24 6295 8884
```

Its public service page describes telecom top-up, phone/game-card distribution (including Garena and Zing), digital goods, bill payment, and SMS Brandname. A public tax/business lookup independently resolves tax ID `0105837941` to the same company (the lookup itself disclaims that it is aggregated data).

The official iMedia Facebook page also contains a warning that individuals/groups have used iMedia’s logo, information, and reputation on mobile/social channels including Lotus and Telegram. That warning is consistent with the possibility that the QR account is being used by a customer, reseller, merchant-of-record, mule, or unauthorized impersonator.

A third-party business directory associates **Phạm Ngọc Tú** with tax ID `0105837941`; official iMedia content also names him in an executive context. This is corporate identity context only. There is no evidence in this case linking Phạm Ngọc Tú or iMedia staff to the campaign, and the directory is not an authoritative finding of criminal responsibility.

The correct next step is a provider-side KYC/transaction inquiry for **ZaloPay app 4982 / virtual account Z397926244101696205**, not an accusation based on the receiver name.

## Related lead: `napthetiktok.online`

Passive RDAP records for `napthetiktok.online` show:

```text
Registered:  2026-07-12T15:58:57.160Z
Registrar:   Spaceship, Inc. (IANA 3862)
Nameservers: decker.ns.cloudflare.com, saanvi.ns.cloudflare.com
Status:      client hold, client update prohibited, client transfer prohibited
Last change: 2026-08-31T19:27:44.180Z
```

Search history suggested similar TikTok recharge wording/template, but the exact historical HTML was not independently recovered in this investigation. Treat it as a **related/uncorroborated lead**, not a 21st verified member.

## Candidate developer/persona lead: `taiapi` / `gaudev` / “Gấu”

Public-source correlation found this cluster:

* GitHub account **`taiapi`**, user ID `176197717`, `public_repos=0`, `public_gists=888` at capture. Seven February 4–5, 2026 “Upload shop” gists contain Node.js Play Together VNG bot code and credits such as `Trùm cuối Gấu dev`, `trùm gaudev`, `gaudev`, `dongdev`, and `yamato`.
* Public Facebook profile ID `100085636317402` displays **Phạm Hữu Tài (Gấu)**; `facebook.com/taiapi` displays **Tai Api**; public **Gau Dev** profile ID is `61593644902237`.
* The Tai Api and Gau Dev Facebook captures use identical avatar bytes (SHA-256 `428e21990cc10f5c152cf1e4ad45defae8c13bb9bedfd6843b137a7b24be7d42`). Public TikTok snapshots show `@gaudev` (nickname `Dev`) and `@taiapi` (nickname `Tai Api`).
* The gists use generic ZaloPay/VietQR routines for a different Play Together/VNG workflow. Normalized comparison found no exact shared lines or meaningful source fingerprint between the fake-shop client and the sampled `shop.js` code.

### Negative findings and confidence limits

No `taiapi`, `gaudev`, Phạm Hữu Tài, campaign domain, `103.149.86.246`, or live account `Z397926244101696205` string was found in the fake-shop HTML/JavaScript evidence. The fake-shop source also does not contain a direct GitHub URL or unique identifier for this persona. Public code artifacts contain unrelated credential-like material; those values are neither reproduced nor included in the committed evidence derivatives.

This is therefore a lawful follow-up lead for correlation (provider KYC, registrar records, server logs, and account metadata), **not an identification** and not a basis for public accusation.

## Takedown and current disposition

* Internal provider records show 15 reported provider actions and 4 failed attempts in the available CSV; these statuses describe the reporting workflow, not a universal takedown.
* Hostinger’s only substantive reply (received `2026-08-27T15:50:04Z`) said `huuhanstudio.space` was **already suspended**, while `shop.huuhanstudio.space` was **not hosted on Hostinger’s network**. This is a useful distinction between registrar and hosting provider, not evidence about every campaign domain.
* At `2026-09-01T04:18:29Z`, Cloudflare authoritative servers still answered `NOERROR` for `hungdungmedia.fun` and `napxu.hungdungmedia.fun`, while public resolver `1.1.1.1` returned **NXDOMAIN** from the `.fun` registry. The final RDAP at `04:19:03Z` listed `client hold`, `server hold`, `client transfer prohibited`, and `add period`; its `last changed` time was `2026-08-31T18:36:39.771Z`, shortly after the report.
* Despite the public DNS/registry state, direct IP + Host-header access continued to return the fake page. DNS suspension therefore did not immediately remove the origin service or its virtual host.

## Unresolved questions

1. Who controlled the application and virtual hosts on `103.149.86.246` (subscriber identity, SSH/deployment logs, reverse-proxy configuration, and source repository)?
2. Who opened or controlled ZaloPay `app_id=4982` and virtual account `Z397926244101696205`, and what KYC/settlement accounts received funds?
3. Was IMEDIA an authorized merchant-of-record/reseller, an unwitting intermediary, or an impersonated brand? What do its onboarding, webhook, and dispute records show?
4. Which registrar accounts, payment instruments, email addresses, and recovery numbers created the 20 Hostinger domains? Were the 4 marty/serena domains created from the same account/workflow?
5. Did the server retain victim TikTok IDs, session cookies, card serial/PIN values, IP logs, or payment attempts? What data was actually returned by `/buy`?
6. Is `taiapi`/`gaudev` merely a generic public developer identity, a reseller/developer connected to a customer, or unrelated? Current evidence cannot decide.
7. Are there additional domains using the same normalized HTML or asset hashes, including the unverified `napthetiktok.online` lead?

## Lawful preservation and request checklist

Preserve and request records through the relevant provider/legal channels; do not contact suspected operators or make another order.

### Immediate preservation

* Preserve the complete local evidence directory, including raw MHTML, response headers, screenshots, RDAP/DNS responses, and correspondence, under access-controlled legal hold.
* Preserve the immutable phishing-support artifact IDs and hashes in `artifacts_tiktok.csv`; keep acquisition timezone and source URL with every derivative.
* Preserve the sanitized derivatives in this commit and recompute their hashes after transfer.

### Provider requests

* **ZaloPay / Công ty cổ phần Zion:** preserve KYC, app-owner, API credentials/ownership history, virtual-account issuance, settlement, transaction, dispute, webhook, device/IP, and beneficiary records for `app_id=4982`, account `Z397926244101696205`, order/QR timestamps around `2026-09-01T02:35Z–04:06Z`, and any related accounts.
* **IMEDIA JSC:** ask whether the account is theirs or a customer/reseller account; preserve merchant onboarding, reseller agreements, API/webhook logs, account mapping, refunds/complaints, and impersonation reports. Do not infer guilt from the receiver label.
* **Hostinger / registry operators:** preserve registrar account/KYC, payment method, login/IP/device history, DNS changes, nameserver history, and hosting/subscription records for all 20 roots; correlate the `2026-08-14` and `2026-08-31` batches.
* **Cloudflare:** preserve zone/account ownership, DNS history, proxy/origin changes, abuse tickets, and logs for the Cloudflare nameserver pairs and campaign roots.
* **4S Technology / APNIC/VNNIC:** preserve subscriber assignment, VPS/dedicated-server tenancy, flow/firewall logs, virtual-host/deployment records, and abuse history for `103.149.86.246` and `103.149.86.0/23`.
* **TikTok:** preserve account-resolution and abuse records for the public IDs used by the sites and any victim reports; distinguish ordinary public profile lookup from authentication.
* **GitHub/Facebook/TikTok (public-source preservation):** preserve URLs, timestamps, public profile IDs, gist revisions, and hash snapshots for the `taiapi`/`gaudev` lead without attempting private access or using leaked tokens.

## Source URLs and retrieval notes

The following public sources were consulted read-only. They are listed for provenance, not as claims that the services endorse the investigation; live pages may change after the stated captures.

* **TikTok:** [Help Center — Gifts/Coins](https://support.tiktok.com/en/live-gifts-wallet/gifts/gifts), [Virtual Items Policy](https://www.tiktok.com/legal/page/row/virtual-items/en), and the official recharge URL `https://www.tiktok.com/coin`.
* **IMEDIA:** [official site](https://imediatech.com.vn/), captured API base `https://imediatech.com.vn/web/api`, and the [official Facebook impersonation warning](https://www.facebook.com/iMediaTechnologyCompany/posts/879023074224185/).
* **Network registration:** [APNIC RDAP for 103.149.86.246](https://rdap.apnic.net/ip/103.149.86.246), [RIPEstat prefix view](https://stat.ripe.net/103.149.86.0/23), and [Shodan host record](https://www.shodan.io/host/103.149.86.246).
* **Payment metadata:** ZaloPay’s read-only dynamic-QR information endpoint (`https://zlp-ofp-emvco-gateway.zalopay.vn/v1/emvco/dynamic-qr/info`). No payment or state-changing API was used.
* **Candidate public identities:** [GitHub `taiapi`](https://github.com/taiapi), [representative Upload shop gist](https://gist.github.com/taiapi/cccbf2c830e6909801df6537bad51386), [TikTok `@gaudev`](https://www.tiktok.com/@gaudev), and [TikTok `@taiapi`](https://www.tiktok.com/@taiapi). Public Facebook profile IDs and snapshots are recorded in the local evidence manifest; no private access was attempted.

The campaign URLs themselves are intentionally shown as code literals in this report and IOC exports rather than auto-linked. This reduces accidental navigation to live or recycled infrastructure.

## Chain of custody and evidence index

The working `investigation/tiktok` directory contains approximately **191,917,985 bytes across 1,269 files** at manifest generation. The Git commit intentionally contains only small, sanitized/derived documentation artifacts. Raw captures remain local because they are large and include temporary cookies, transaction tokens, correspondence metadata, and unrelated public-code credential-like material.

`evidence_manifest.json` records SHA-256 and byte size for the key report inputs, including the 19 MHTML pages used for template comparison, all 20 root RDAP records, the origin/QR/network captures, corporate-source captures, and correspondence. It also records which paths were deliberately excluded from the commit. `campaign_iocs.*`, `template_fingerprint.json`, `qr_order_evidence.json`, and `origin_observation.json` are committed derivatives; their hashes are listed in the manifest.

### Key committed derivatives

| File | Purpose |
|---|---|
| [`REPORT.md`](REPORT.md) | Human-readable assessment and lawful follow-up plan. |
| [`campaign_iocs.json`](campaign_iocs.json) | 20 verified campaign IOCs plus one unverified related lead. |
| [`campaign_iocs.csv`](campaign_iocs.csv) | Flat IOC export for blocklist/case tooling. |
| [`template_fingerprint.json`](template_fingerprint.json) | Reproducible normalized HTML and static-asset comparison. |
| [`qr_order_evidence.json`](qr_order_evidence.json) | Sanitized order/EMV/ZaloPay evidence; no session/token values. |
| [`origin_observation.json`](origin_observation.json) | Sanitized direct-origin, DNS split, RIR, and service observation. |
| [`evidence_manifest.json`](evidence_manifest.json) | Hashes, provenance, sensitivity and commit boundaries. |

## Limitations and interpretation rules

* A registrar, network owner, payment intermediary, or brand named in an artifact is not thereby the perpetrator.
* Cloudflare edge IPs are not origin IPs. The origin conclusion rests on direct Host-header behavior and authoritative historical DNS, not on current public resolver output.
* RDAP `client hold`/`server hold`, NXDOMAIN, default pages, and 503 responses are point-in-time states; they do not establish when an operator stopped retaining data.
* A valid QR proves what destination the site presented, not that funds were received or that the named receiver knew about the fraud.
* Public aliases and code credits are leads. They are not identity proof, and the absence of a string in client code is not proof of non-involvement.
* The login form’s explicit no-password design means this report must not overstate password phishing. Payment/card collection and fraudulent recharge are the demonstrated abuse modes.
* Historical HTML for `napthetiktok.online` was not recovered; it remains an unverified related lead.

## Bottom line

The defensible attribution is **campaign → shared kit → origin IP/network → payment-account lead**, not **campaign → named individual**. The next evidentiary step is provider-side preservation and KYC/log correlation for `103.149.86.246`, Hostinger/Cloudflare account history, and ZaloPay `app_id=4982`. Until those records are obtained, the campaign operator and any knowing intermediary remain unidentified.
