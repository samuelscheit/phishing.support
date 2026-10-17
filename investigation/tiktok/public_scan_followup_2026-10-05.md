# Public-source follow-up — 2026-10-05

## Scope and handling

Read-only review of public URLScan search/results, public RDAP and DNS-over-HTTPS responses, Certificate Transparency (CertSpotter), and the already documented public GitHub lead. No campaign shop was opened, no forms were submitted, no suspected operator was contacted, and no private-person identity was sought. This note records a candidate page separately; it does not silently add it to the verified campaign IOC cohort.

## Result: no newly verified continuation of the known 22-host campaign

A URLScan public-search query covering the 20 historical IOC hosts plus the two post-cutoff continuations, filtered with `date:>2026-09-01`, returned zero scans. The response reports `search_date_limit_days: 30`; at the 2026-10-05 capture time this only observes approximately 2026-09-05 through 2026-10-05. It does not establish that any host was down, removed, or inactive, and it leaves 2026-09-01 through 2026-09-04 outside this query's effective coverage.

## New lookalike-themed scan candidate: `xupay.store`

URLScan's public title search for `"Nạp xu TikTok"` in the post-2026-09-01 interval returned one result:

- Public URLScan result: [`01a0ab8a-409e-75fe-85f9-aa7e73e96e19`](https://urlscan.io/result/01a0ab8a-409e-75fe-85f9-aa7e73e96e19/)
- Screenshot: [captured screenshot](https://urlscan.io/screenshots/01a0ab8a-409e-75fe-85f9-aa7e73e96e19.png)
- Scan time: `2026-09-16T18:46:10.224Z`
- Captured URL: `https://xupay.store/`; scan status `200`; page title `Nạp Xu TikTok Giá Rẻ - Nạp Xu Nhanh Chóng`; Vietnamese language; URLScan lists this as the only scan of the domain and no classification.
- URLScan observed 14 HTTP requests. Its result page lists the primary HTML response hash `b784f8a27333e0a2a5043ab43c1a5cdc90acf221d0f9f21cc3f5344fe83bea48` and `/assets/js/app.js` hash `35c9b3978543785f538394155d924ff785855dec0377c2d30ed6ab276996a409` (727-byte response). A public `hash:` search for that JavaScript hash returned only this scan.
- OCR of the URLScan screenshot recognized `HỆ THỐNG ĐANG ONLINE` and `Nạp xu TikTok siêu tốc — tự động 24/7 — bảo mật tuyệt đối`. This supports only that the captured page presented TikTok-recharge-themed copy; it does not independently prove fraud or campaign membership.

### Passive registration, DNS, and certificate context

- Public RDAP was queried through [rdap.org](https://rdap.org/domain/xupay.store) at `2026-10-05T04:16:36Z`. It records registration at `2026-09-13T03:54:36.439Z`, Name.com, Inc. (IANA registrar ID `625`), Cloudflare nameservers `chan.ns.cloudflare.com` and `joaquin.ns.cloudflare.com`, and a redacted registrant. Name.com and Cloudflare are service-provider roles, not operator attribution.
- Google Public DNS returned A records `188.114.97.3` and `188.114.96.3`, and the same Cloudflare nameserver pair, at `2026-10-05T04:27:19–20Z`. These are Cloudflare proxy/edge addresses, not a verified origin.
- [CertSpotter public CT API](https://api.certspotter.com/v1/issuances?domain=xupay.store&include_subdomains=true&expand=dns_names) showed apex/wildcard certificates beginning `2026-09-13` and one host-specific certificate issued `2026-09-25`. The host-specific label is omitted because it could be personal; certificate issuance alone does not establish a registered business, control of the campaign, or even that the host served the same content.

### Campaign-correlation test and limits

The known campaign's baseline is the exact normalized HTML fingerprint and 32 shared `/public/images/tiktok/**` asset hashes in [`template_fingerprint.json`](template_fingerprint.json). The public URLScan result page for `xupay.store` lists a separate 14-request resource set (HTML, Google font resources, the 727-byte local script, and a zero-byte favicon); no matching campaign asset was visible in that request inventory. Public URLScan `hash:<sha256>` lookups showed that some generic telecom-card PNGs also appear in other public scans with unrelated page titles, including an October 3 Free Fire recharge page; those individual icons have low attribution value. Twenty-four of the queried campaign method/SVG asset hashes returned no public scan matches in this rolling search window; two final hash lookups were rate-limited, so those searches are incomplete. The URLScan result JSON and archived response-body endpoints returned HTTP 403 in this read-only session, so the captured HTML could not be compared against the campaign's normalized HTML fingerprint or backend routes. No live page was fetched. The title, theme, country/language, and Cloudflare use therefore remain weak similarities, not a technical link.

The established cohort used `decker`/`saanvi` or `marty`/`serena` nameservers in the preserved records, not xupay’s `chan`/`joaquin` pair; xupay also has a different registrar from the 20 historical domains (Hostinger Operations, UAB). These differences do not prove separate operators. No direct tie to the known campaign origins or payment identifier was found, and no verified public source/repository or provider-account link connects xupay to the documented campaign.

The existing public repository lead [`QuocTuan-8386/duanmoi`](https://github.com/QuocTuan-8386/duanmoi) remained at its documented `2026-09-19` push/update state when checked on 2026-10-05; no public source inspected here tied its account or storefront pages to `xupay.store` or the known live campaign origins/payments.

## Disposition

`xupay.store` is a **low-confidence lookalike-themed public scan candidate**, not a verified continuation of the 22-host campaign and not an operator attribution. It is intentionally excluded from `campaign_iocs.*`, `campaign_continuations.*`, and any blocklist pending direct campaign-body, unique-asset/source, origin, or payment correlation. No verified operator-linked public business entity was found in this follow-up. Provider/registry KYC and origin/payment records remain outside public passive evidence.

## Fresh read-only live metadata check — 2026-10-05T04:52:41Z

A second, non-interactive read-only check was made after the public URLScan review. It requested only the public root document and static assets; it did not submit forms, follow login/registration flows, create an account, or call an order/payment endpoint.

- `GET https://xupay.store/` returned HTTP 200, `Content-Type: text/html; charset=UTF-8`, and a 2,532-byte body with SHA-256 `b4ac543ed27847106dda872ce2fc41cb14bf6f0e6a32afb671c82db03b9080d7`.
- The current document title is `XUPAY TikTok`; the current public description is `Nạp xu TikTok tự động, nhanh chóng và bảo mật.`. The document contains links to `/login` and `/register`, but no HTML form and no campaign `/login`, `/qr_order`, `/qr_status`, `/buy`, `/cards`, or `/logout` route references.
- The current response exposed only generic infrastructure/runtime headers (`server: cloudflare`, `x-powered-by: PHP/8.2.28`, `x-turbo-charged-by: LiteSpeed`). These identify service/software layers, not an operator or subscriber. The `Set-Cookie` value was not copied into this note.
- Google Public DNS at this observation returned `188.114.97.12` and `188.114.96.12`; the nameservers remained `chan.ns.cloudflare.com` and `joaquin.ns.cloudflare.com`. These are Cloudflare proxy/edge records, not a verified origin. The 2026-09-16 URLScan observation used the different Cloudflare edge `188.114.97.3`, so the edge-address change is not an origin transition or an operator link.
- The live static stylesheet `/assets/app.css` was 5,136 bytes with SHA-256 `cb88912cf6c49a2ca64c93339b6f545fe8200bff58c74180fe99e72026302a66`; `/assets/favicon.svg` was 315 bytes with SHA-256 `a0b3642b2e463e0c2ec406cacda9b9c8806cf67714838ad7830ed116a785c774`. No URL path or asset name under `/public/images/tiktok/**` was requested by the current document.
- The current page's structure is materially different from the preserved campaign page: it is a short XUPAY-branded landing page with CSS links and account-navigation links, no captured campaign logo/payment-card asset paths, and no in-page TikTok-ID/session/payment form. The raw page hash is not evidence of identity, but it is a reproducible negative against treating the current root document as the known 22-host HTML fingerprint.
- Public CT/RDAP context remains unchanged: the domain was registered on 2026-09-13 through Name.com (IANA 625), with redacted registrant data and a separate Cloudflare nameserver pair from the historical cohort. The observed certificate/host labels were not used for person-level attribution.

**Updated disposition:** `xupay.store` remains a separate, low-confidence lookalike-themed candidate. Public evidence confirms a Vietnamese TikTok-recharge presentation and a historical URLScan scan, but no direct campaign-body/asset hash, backend-route, origin, registrar, payment, repository, or provider-account correlation to the 22 documented hosts. No operator-linked public business entity was found. It remains excluded from `campaign_iocs.*`, `campaign_continuations.*`, and any claim of common control.

### Clarification to the live-check bullet above

The phrase “no campaign `/login` ... route references” means that the page has no reference to the **known campaign's in-page login/session route behavior** or to the known route family as a whole. The current document does contain ordinary navigation links to `https://xupay.store/login` and `https://xupay.store/register`; those links were not followed. The remaining known campaign API routes (`/qr_order`, `/qr_status`, `/buy`, `/cards`, `/logout`) do not occur in the current root document.
