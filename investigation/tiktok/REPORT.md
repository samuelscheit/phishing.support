# TikTok recharge campaign — attribution and evidence report

> **Assessment status:** follow-up investigative synthesis; not a legal finding and not an identification of a perpetrator.
> **Prepared (UTC):** 2026-09-01T09:25:00Z
> **Evidence cutoff (UTC):** 2026-09-01T09:19:56Z
> **Case label:** `tiktok-recharge-campaign`
> **Repository scope:** investigation documentation only; no production application code was changed.

## Executive conclusion

This investigation identifies a **coordinated Vietnamese-language fake TikTok Coins recharge campaign** comprising **20 verified domains/subdomains** reported between **2026-08-19T08:55:17Z and 2026-08-31T18:22:24Z**. Nineteen of the twenty campaign pages have preserved MHTML captures; `shop.sonhaimedia.sbs` is retained as an IOC but has no MHTML artifact. The captured pages have one normalized HTML fingerprint and 32 byte-identical TikTok image/SVG assets across all 19 captures. The pages present TikTok branding, coin bundles, a fake login gate, prepaid-card fields, and bank-transfer QR payment.

The strongest technical lead is the serving origin **`103.149.86.246`**. On 2026-09-01, an HTTP request sent directly to that address with `Host: napxu.hungdungmedia.fun` returned the 186,877-byte fake recharge page (`Apache`, HTTP 200). APNIC/RIR data place the address in **103.149.86.0/23, AS149125 (`DV4S-VN`)**, registered to **4S TECHNOLOGY TRADING SERVICES COMPANY LIMITED** in Vietnam. This is a **network/hosting attribution**, not proof that 4S Technology or its listed contacts operated the fraud. A historical control also matters: `napgarena.vn` served a different Vietnamese game portal from the adjacent `103.149.87.34` address in the same /23 and ASN. The network registrant therefore cannot be treated as the campaign operator without subscriber and server records.

A single **synthetic/public-user** probe (username `tiktok`, amount VND 50,000) obtained order **7052** without paying. The generated EMVCo QR named **IMEDIA JSC** as receiver, account **`Z397926244101696205`**, and resolved through ZaloPay metadata as **`app_id=4982`**. The order was later reported `expired`; no payment, card value, password, OTP, or private credential was submitted. This is a strong **payment-account lead**, not proof of who controlled the account or whether IMEDIA knowingly participated.

New public-source correlation identifies **`QuocTuan-8386/duanmoi`** as a **medium-confidence kit-publisher/reseller lead**, not an identified perpetrator. The repository's July 2026 page contains **31 of the 32 campaign static assets byte-for-byte**, and the public GitHub Pages response is byte-identical to the repository's `0e0e309…` revision. That revision preserves a `saved from` comment naming `nap-xu.orvantis.online`; the page was independently scanned four times, including one URLScan submission tagged `phishdestroy` and one sourced automatically from OpenPhish. However, the same static-asset family and an older related front-end JavaScript were publicly observed on `napxu.vip` in December 2024, `naptiktok.app-s1.online` in February 2025, and `naptiktok.net` in June 2025. The QuocTuan repository is therefore evidence of a public publisher/republisher of a circulating kit, not proof that the account authored the kit, operated the 20 live domains, controlled `103.149.86.246`, or controlled the ZaloPay destination.

The public `taiapi` / `gaudev` / “Gấu” material remains a **lower-confidence investigative lead**: it shows a Vietnamese developer persona publishing unrelated Play Together/VNG bot code with generic ZaloPay/VietQR routines and cross-platform aliases. No fake-shop domain, origin IP, payment account, exact code fingerprint, or operator credential links that persona to this campaign. The **actual perpetrator identity remains unresolved**.

### Attribution at a glance

| Question | Confidence | What the evidence supports | What it does **not** support |
|---|---|---|---|
| Are these sites one campaign/kit? | **High** | 20 related IOCs, shared wording/flow, one normalized HTML fingerprint across 19 captures, 32 shared static assets, repeated Cloudflare/Hostinger pattern. | The legal identity of the author or operator. |
| Which host served the live application? | **High** | Direct Host-header request to 103.149.86.246 returned the fake page; ten apexes also exposed that address in the 2026-09-01 authoritative snapshot. | That the network registrant authored or knew about the content. |
| Which payment destination was shown? | **High** | Order 7052 and read-only ZaloPay lookup agree on IMEDIA JSC / account Z397926244101696205 / app 4982. | The KYC customer, beneficial owner, or knowledge/intent of IMEDIA. |
| Is IMEDIA JSC the scammer? | **Not established** | IMEDIA is a real telecom/digital-goods/payment intermediary and publicly warns about impersonation. | Any knowing involvement; no such evidence was found. |
| Does `QuocTuan-8386/duanmoi` identify the operator? | **Medium kit-publisher lead only** | Public repository control, 31/32 exact campaign assets, a byte-identical public Pages response, and a copied `nap-xu.orvantis.online` source comment. | Operation of the 20 domains, control of the live origin/payment account, authorship of the original kit, or a verified natural-person identity. |
| Is `taiapi` / `gaudev` the operator? | **Low lead only** | Public aliases, code credits, and matching public avatars form a coherent persona cluster. | A technical or financial link to this campaign. |
| Who is the perpetrator? | **Unresolved** | Further provider records and lawful process are needed. | A defensible individual attribution from current evidence. |

## Scope, method, and safety boundaries

### Collection scope

* Phishing-support submissions and immutable artifact metadata (`artifacts_tiktok.csv`, `provider_reports_tiktok.csv`, and `report_threads_tiktok.csv`).
* Read-only HTTP retrievals, direct virtual-host checks, DNS and authoritative DNS queries, RDAP/APNIC/RIPEstat records, and a passive Shodan service record.
* Static HTML/JavaScript/MHTML comparison and extraction of client-side routes and data fields.
* Public corporate pages/API responses for IMEDIA; public GitHub, Facebook, and TikTok profile material for a candidate lead.
* A read-only ZaloPay dynamic-QR metadata lookup for the captured QR payload.
* Public URLScan result pages/resource hashes, certificate-transparency/RDAP snapshots, and public GitHub repository history for exact-kit and source correlation.
* Historical same-ASN observations, including a non-campaign `napgarena.vn` control, to separate network continuity from account-level attribution.

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
| 2026-09-01T04:48:58Z | Related `napthetiktok.online` RDAP snapshot captured. | `related_sites/napthetiktok_rdap.json` |
| 2026-09-01T06:38:04Z–09:19:56Z | Historical exact-kit domains and the `orvantis.online` source-page lead were rechecked with public URLScan, RDAP, and certificate-transparency records. | `related_sites/urlscan_result_pages/`, `related_sites/exact_kit/`, `related_sites/orvantis_certspotter.json` |
| 2026-09-01T09:25:00Z | QuocTuan repository history, byte-level asset overlap, legacy-kit lineage, and the same-ASN `napgarena.vn` control were consolidated into the follow-up derivatives. | `source_correlation.json` |

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

Machine-readable exports are in [`campaign_iocs.json`](campaign_iocs.json) and [`campaign_iocs.csv`](campaign_iocs.csv). Schema version 2 retains the 20 verified members separately from five historical/related leads. Those leads are **not** current blocklist entries and are intentionally outside the verified-member count; their technical dispositions are in [`source_correlation.json`](source_correlation.json).

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

The 19 captured campaign MHTML pages were compared after a deliberately narrow normalization: decode the MIME HTML payload as UTF-8 with replacement, lowercase, replace each URL's scheme and authority (preserving its path) with `HOST`, replace `cid:` references with `CID`, collapse whitespace, and hash the resulting UTF-8 comparison string. For asset hashes, SVG transport line endings are canonicalized from CRLF/CR to LF while binary image bytes are left unchanged. All 19 produced:

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

## Expanded kit and source correlation

The follow-up work distinguishes three things that are often incorrectly collapsed: **a reused front-end kit**, **a particular deployment**, and **the person who controlled that deployment**. The first two can be strongly correlated here; the third cannot yet be identified. The reproducible, sanitized record is [`source_correlation.json`](source_correlation.json).

### Two historical deployments used the complete 32-asset campaign bundle

Public URLScan transaction records show two domains outside the 20 submitted case members loading **every one of the 32 SHA-256 asset hashes** shared by the captured campaign pages. Both also exposed the title `Nạp xu TikTok`, the same visible package pricing/promotion wording, and the same 37-request resource bundle.

| Historical deployment | URLScan observation(s) | Exact campaign assets | Historical hosting seen by URLScan | Current/RDAP context | Disposition |
|---|---|---:|---|---|---|
| `napxutiktok.sbs` | `019f6f39-d115-7636-bfba-f749b16b39b1` at `2026-07-17T08:38:14.556Z` | **32/32** | Cloudflare edge `172.67.132.229` | Registered `2026-07-15`; Spaceship; `decker`/`saanvi`; held at follow-up RDAP capture. | Related exact-kit deployment; not a case submission. |
| `napthegarena.online` | `019fba8b-7e22-733c-be90-d604e0e800d5` at `2026-07-31T23:38:58.092Z`; `01a01c43-6622-7391-bcdc-6f00422c59c5` at `2026-08-19T23:03:00.473Z` | **32/32** in each scan | Cloudflare edges `188.114.97.3` and `188.114.96.3` | Registered `2025-11-26`; NameCheap; `decker`/`saanvi`; client-held at follow-up RDAP capture. | Related exact-kit deployment; not a case submission. |

This is strong evidence of a **circulating full kit**, not proof that either historical domain used `103.149.86.246`, ZaloPay app 4982, the IMEDIA virtual account, or the same registrar account as the 20 submitted domains.

### Public GitHub Pages repository: strong republishing correlation, limited actor attribution

The public repository [`QuocTuan-8386/duanmoi`](https://github.com/QuocTuan-8386/duanmoi) is the most concrete public-source lead found in this follow-up. Its account was created at `2026-07-18T13:47:21Z`; the repository was created at `2026-07-18T13:55:08Z` and has GitHub Pages enabled. Public GitHub activity records show branch creation and subsequent pushes by the `QuocTuan-8386` account, including the July 20 revision and five August 13 revisions followed by the August 15 update. The initial commits use placeholder Git author metadata, so those fields are not treated as identity proof.

The July 20 revision `0e0e309a93f2f84e9474c73718ddaa39825a2593` has SHA-256:

```text
7a34047088685a8bcbb83bbf41dd0e306a330612bdfccc9baf2b63b532865451
```

That is the same primary-response hash recorded by URLScan for the repository's GitHub Pages site in all four scans from 2026-07-21/22. The revision's `rc/` folder has **31 exact byte matches out of the campaign's 32 shared assets**; the only campaign asset absent from that `rc/` comparison is `/public/images/tiktok/svg/coin.svg`. This is substantially stronger than visual similarity or a single-logo match.

The copied page begins with a comment saying it was saved from:

```text
https://nap-xu.orvantis.online/
```

The four public Page scans are:

```text
019f84b9-ecd2-7105-b73c-f2e4e83e04ff  2026-07-21T12:50:14.619Z  phishdestroy tag
019f84c5-c306-764d-8efa-610b82c9ebbd  2026-07-21T13:03:07.135Z  automatic OpenPhish source
019f8583-b2d7-762c-a11a-68199c8343f3  2026-07-21T16:30:39.628Z
019f8b1c-d3c1-74a1-b818-59e0541141ab  2026-07-22T18:35:56.606Z
```

PhishDestroy's public record `161899` also maps the 2026-07-21 Pages URL to the first UUID. This independently supports treating the public page as suspicious/phishing-related. It does **not** identify the owner of the 20 submitted domains.

The repository source differs materially from the live campaign implementation. Its early page performs a public TikTok-profile lookup and drives a client-side payment/demo UI. Across all eight public `index.html` revisions inspected, there is no literal match for the live campaign backend routes:

```text
/login  /qr_order  /qr_status  /buy  /cards  /logout
```

It also contains no current campaign domain, `103.149.86.246`, IMEDIA receiver, live virtual account, or ZaloPay `app_id=4982` string. A credential-like third-party API value encountered in repository history was not used or reproduced. The defensible assessment is therefore **public kit publisher/republisher or reseller lead — medium confidence**, not kit author or live-campaign operator.

### The public kit lineage predates the GitHub account

The QuocTuan result cannot be read as authorship because representative URLScan observations predate the account by many months:

| Public historical observation | Date | Shared evidence | Why it matters |
|---|---|---|---|
| `napxu.vip` (`4b03f732-3fd2-4bd6-96e3-6e944ade097c`) | `2024-12-25T01:12:58.750Z` | Same Vietnamese TikTok recharge/no-password presentation, the same `s.js` SHA-256 `584dc8fb5b08ecf0a40d2fd4bd106422050ee02a60ebeede1e7bfecfd78f8c53`, and 10 exact campaign avatar/payment assets. | Demonstrates an earlier circulating front-end family. |
| `naptiktok.app` → `naptiktok.app-s1.online` (`15c8070c-a1ed-4da9-b5f6-433897439f1d`) | `2025-02-19T09:33:07.473Z` | Same `s.js` hash and matching asset subset. | Further predates the GitHub account and reduces source-author confidence. |
| `naptiktok.net` (`019754a0-9b7a-7781-8c6a-ad887d26a2e6`) | `2025-06-09T12:18:28.430Z` | Same `s.js` hash, same no-password wording, and 10 exact campaign assets. | Adds a historical deployment on the current origin's network prefix. |

The later full 32-asset cluster first observed by the public searches is still useful for correlating the July/August 2026 deployments, but the older subset proves that static assets and generic client logic are not unique to `QuocTuan-8386`.

### `orvantis.online` and adjacent-network caveats

`orvantis.online` was registered on `2026-02-10T11:09:28Z` through Hostinger and used `decker.ns.cloudflare.com` / `saanvi.ns.cloudflare.com`. Certificate transparency recorded `*.orvantis.online` from `2026-06-25T09:21:03Z` through `2026-09-23T10:19:44Z`; the follow-up RDAP record is client-held. These traits overlap the later campaign's provisioning pattern, but they are not unique. No independently captured `nap-xu.orvantis.online` HTML, URLScan result, origin address, payment identifier, or backend code was recovered. It is a **source-page lead only**.

The historical `naptiktok.net` scan was served directly from **`103.149.87.34`**, which falls in the same `103.149.86.0/23` / `AS149125` allocation as the current `103.149.86.246` origin. That is a useful infrastructure-continuity lead. It is not subscriber identity: URLScan records also show the different `napgarena.vn` game portal on `103.149.87.34` in December 2024. This control prevents the erroneous conclusion that all content in the /23 or the 4S Technology registrant is operated by one actor.

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

## Additional uncorroborated lead: `napthetiktok.online`

Passive RDAP records for `napthetiktok.online` show:

```text
Registered:  2026-07-12T15:58:57.160Z
Registrar:   Spaceship, Inc. (IANA 3862)
Nameservers: decker.ns.cloudflare.com, saanvi.ns.cloudflare.com
Status:      client hold, client update prohibited, client transfer prohibited
Last change: 2026-08-31T19:27:44.180Z
```

Search history suggested similar TikTok recharge wording/template, but the exact historical HTML was not independently recovered in this investigation. Treat it as a **related/uncorroborated lead**, not a 21st verified member. The distinct exact-kit, source-page, and historical-network leads are described in [Expanded kit and source correlation](#expanded-kit-and-source-correlation) and retained with explicit non-blocklist dispositions in `campaign_iocs.*`.

## Separate lower-confidence persona lead: `taiapi` / `gaudev` / “Gấu”

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
6. Is `QuocTuan-8386` merely a public kit republisher/reseller, a developer connected to a customer, or the operator of any deployment? The pre-existing 2024–2025 lineage and absence of live-domain/payment strings prevent a conclusion.
7. Is `taiapi`/`gaudev` merely a generic public developer identity, a reseller/developer connected to a customer, or unrelated? Current evidence cannot decide.
8. Are there additional domains using the same normalized HTML or asset hashes, including the unverified `napthetiktok.online` lead?

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
* **GitHub/Facebook/TikTok (public-source preservation):** preserve URLs, timestamps, public profile IDs, repository revisions, URLScan IDs, and hash snapshots for the `QuocTuan-8386` and `taiapi`/`gaudev` leads without attempting private access or using leaked tokens.

## Source URLs and retrieval notes

The following public sources were consulted read-only. They are listed for provenance, not as claims that the services endorse the investigation; live pages may change after the stated captures.

* **TikTok:** [Help Center — Gifts/Coins](https://support.tiktok.com/en/live-gifts-wallet/gifts/gifts), [Virtual Items Policy](https://www.tiktok.com/legal/page/row/virtual-items/en), and the official recharge URL `https://www.tiktok.com/coin`.
* **IMEDIA:** [official site](https://imediatech.com.vn/), captured API base `https://imediatech.com.vn/web/api`, and the [official Facebook impersonation warning](https://www.facebook.com/iMediaTechnologyCompany/posts/879023074224185/).
* **Network registration:** [APNIC RDAP for 103.149.86.246](https://rdap.apnic.net/ip/103.149.86.246), [RIPEstat prefix view](https://stat.ripe.net/103.149.86.0/23), and [Shodan host record](https://www.shodan.io/host/103.149.86.246).
* **Payment metadata:** ZaloPay’s read-only dynamic-QR information endpoint (`https://zlp-ofp-emvco-gateway.zalopay.vn/v1/emvco/dynamic-qr/info`). No payment or state-changing API was used.
* **Public kit/source correlation:** [QuocTuan-8386/duanmoi](https://github.com/QuocTuan-8386/duanmoi), [GitHub Pages copy](https://quoctuan-8386.github.io/duanmoi/), URLScan result pages for `napxutiktok.sbs` and `napthegarena.online`, and the public [PhishDestroy destroylist change](https://github.com/phishdestroy/destroylist/blob/main/changes/2026-07/2026-07-22.json) (availability may change).
* **Historical public observations:** URLScan pages for `napxu.vip`, `naptiktok.app`, `naptiktok.net`, and the same-ASN control `napgarena.vn`; exact UUIDs and retrieval hashes are in `source_correlation.json`.
* **Candidate public identities:** [GitHub `taiapi`](https://github.com/taiapi), [representative Upload shop gist](https://gist.github.com/taiapi/cccbf2c830e6909801df6537bad51386), [TikTok `@gaudev`](https://www.tiktok.com/@gaudev), and [TikTok `@taiapi`](https://www.tiktok.com/@taiapi). Public Facebook profile IDs and snapshots are recorded in the local evidence manifest; no private access was attempted.

The campaign URLs themselves are intentionally shown as code literals in this report and IOC exports rather than auto-linked. This reduces accidental navigation to live or recycled infrastructure.

## Chain of custody and evidence index

The working `investigation/tiktok` directory contains the raw captures and sanitized derivatives listed in `evidence_manifest.json`; the Git commit intentionally contains only small, sanitized/derived documentation artifacts. Raw captures remain local because they are large and include temporary cookies, transaction tokens, correspondence metadata, and unrelated public-code credential-like material.

`evidence_manifest.json` records SHA-256 and byte size for the key report inputs, including the 19 MHTML pages used for template comparison, all 20 root RDAP records, the origin/QR/network captures, corporate-source captures, correspondence, and the new public URLScan/GitHub/RDAP correlation records. It also records which paths were deliberately excluded from the commit. `campaign_iocs.*`, `template_fingerprint.json`, `qr_order_evidence.json`, `origin_observation.json`, and `source_correlation.json` are committed derivatives; their hashes are listed in the manifest.

### Key committed derivatives

| File | Purpose |
|---|---|
| [`REPORT.md`](REPORT.md) | Human-readable assessment and lawful follow-up plan. |
| [`campaign_iocs.json`](campaign_iocs.json) | 20 verified campaign IOCs plus five explicitly historical/related leads. |
| [`campaign_iocs.csv`](campaign_iocs.csv) | Flat IOC export for blocklist/case tooling. |
| [`template_fingerprint.json`](template_fingerprint.json) | Reproducible normalized HTML and static-asset comparison. |
| [`qr_order_evidence.json`](qr_order_evidence.json) | Sanitized order/EMV/ZaloPay evidence; no session/token values. |
| [`origin_observation.json`](origin_observation.json) | Sanitized direct-origin, DNS split, RIR, and service observation. |
| [`source_correlation.json`](source_correlation.json) | Byte-level GitHub/URLScan kit correlation, historical lineage, source-page lead, and same-network control with explicit confidence limits. |
| [`evidence_manifest.json`](evidence_manifest.json) | Hashes, provenance, sensitivity and commit boundaries. |

## Limitations and interpretation rules

* A registrar, network owner, payment intermediary, or brand named in an artifact is not thereby the perpetrator.
* Cloudflare edge IPs are not origin IPs. The origin conclusion rests on direct Host-header behavior and authoritative historical DNS, not on current public resolver output.
* RDAP `client hold`/`server hold`, NXDOMAIN, default pages, and 503 responses are point-in-time states; they do not establish when an operator stopped retaining data.
* A valid QR proves what destination the site presented, not that funds were received or that the named receiver knew about the fraud.
* Public aliases and code credits are leads. They are not identity proof, and the absence of a string in client code is not proof of non-involvement.
* The QuocTuan repository is a public publisher/republisher lead. Its exact asset overlap is not unique because the same front-end family was observed publicly before the account existed.
* A same-prefix historical host is not a same-subscriber finding. The `napgarena.vn` control demonstrates why ASN, IP, registrar, and nameserver matches must not be converted into an individual attribution.
* The login form’s explicit no-password design means this report must not overstate password phishing. Payment/card collection and fraudulent recharge are the demonstrated abuse modes.
* Historical HTML for `napthetiktok.online` was not recovered; it remains an unverified related lead.

## Bottom line

The defensible attribution is **campaign → shared kit → public kit-publisher/republisher lead + serving origin/network + payment-account lead**, not **campaign → named individual**. The QuocTuan repository is the strongest public kit correlation, but the kit demonstrably predates that account and no live-domain, server, or payment link was found. The same-ASN `naptiktok.net` observation is useful continuity evidence but shares an address with an unrelated portal. The next evidentiary step is provider-side preservation and KYC/log correlation for `103.149.86.246`, Hostinger/Cloudflare account history, and ZaloPay `app_id=4982`. Until those records are obtained, the campaign operator and any knowing intermediary remain unidentified.
