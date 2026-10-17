# Public payment-app attribution note — 2026-10-05

## Scope and limits

This note addresses only the public meaning of the payment evidence preserved in `qr_order_evidence.json`:

- ZaloPay `app_id=4982`
- receiver label `IMEDIA JSC`
- receiver account `Z397926244101696205`
- partner label `Zalopay` / `Công ty cổ phần Zion`

Research used current public ZaloPay documentation and IMEDIA's public corporate website/search-indexed pages. No private APIs, merchant portals, KYC records, payment records, personal data, authentication, or contact with IMEDIA/ZaloPay was used.

## Public-source findings

1. ZaloPay's official developer documentation defines `app_id` as a ZaloPay-provided identifier for a **merchant's application, web/app/POS, or service**, issued when the merchant registers a payment integration. The documentation gives separate examples for multiple applications (`Merchant Web`, `Merchant App`) and separately defines `sub_app_id` as a service/service-group identifier.
   - English: <https://docs.zalopay.vn/docs/developer-tools/knowledge-base/basic-definition/>
   - Vietnamese: <https://docs.zalopay.vn/vi/docs/specs/order-create/>

2. ZaloPay's dynamic-QR guide says a merchant must register a merchant account and obtain `app_id` and `mac_key` from the Merchant Portal before integrating dynamic QR. This supports treating `4982` as a real production integration identifier for a merchant application/service, not as an IP, domain, person, or publicly searchable legal-owner identifier.
   - <https://docs.zalopay.vn/docs/guides/payment-acceptance/qrcode/dynamic-qr/>

3. ZaloPay's public `getMerchantInfo` documentation explicitly says access to merchant information requires contacting the ZaloPay team and that the method returns a separate merchant identifier (`muid`) for a supplied `appId`. This is strong evidence that `app_id` alone does not publicly reveal the merchant's account/KYC identity.
   - <https://docs.zalopay.vn/vi/docs/miniapp/user/get-merchant-info/>

4. ZaloPay's public operating rules distinguish ZION/ZaloPay as an intermediary platform from the sellers/merchants that contract with it. The rules define sellers as merchants, organizations, or individuals using ZaloPay to sell goods/services and state that sellers are legally responsible for their activity. This means a receiver label or app identifier can point to a merchant-side integration without proving that the platform operator, a named company, or a natural person controlled the scam site.
   - <https://zalopay.vn/quy-dinh/quy-che-hoat-dong>

5. ZaloPay publicly describes IMEDIA as a third-party partner in at least one payment service (loan-payment support), while describing ZION's role as an intermediary. This is not evidence that the campaign's app 4982 belonged to that partner, but it confirms that an IMEDIA label can appear in a legitimate intermediary/partner context rather than identifying a website operator by itself.
   - <https://zalopay.vn/danh-sach-nha-cung-cap-doi-tac-dich-vu-thanh-toan-khoan-vay-cua-zalopay-3907>

6. IMEDIA's own website publicly presents it as `CÔNG TY CỔ PHẦN CÔNG NGHỆ VÀ DỊCH VỤ IMEDIA`, with tax/registration number `0105837941`, public contact details, and a telecom/digital-services business including `HOLA DIGITAL - DỊCH VỤ VIỄN THÔNG`. Its public site also describes its relationship as a Viettel telecom sales/distribution agency. Those facts establish a real company and a plausible digital/telecom business profile, but do not connect it to the fake TikTok pages or prove knowledge of misuse of its label.
   - <https://imediatech.com.vn/>
   - <https://imediatech.com.vn/tin-tuc/chi-tiet/imedia--top-10-dai-ly-xuat-sac-nhat-2025-340>

7. Exact public searches for `app_id=4982`, `IMEDIA JSC`, and `Z397926244101696205` did not locate an official public mapping from the numeric app ID or receiver account to a legal merchant owner, domain, or storefront. The public hits were generic ZaloPay integration documentation, not an account directory.

## Attribution assessment

The sanitized order evidence is best classified as a **high-confidence payment-account lead**:

- It shows that the synthetic order's payment QR/metadata resolved to receiver label `IMEDIA JSC` and account `Z397926244101696205` under ZaloPay app `4982`.
- Public ZaloPay documentation supports that `app_id` is a merchant application/service identifier issued during integration.
- Public sources do **not** establish who controls that integration, who holds the underlying merchant/KYC account, whether IMEDIA itself is the account holder, whether an authorized reseller/partner used it, or whether the label was misused.
- The expired order and absence of payment remain unchanged; no settlement, account, or KYC record is available.

**No attribution change:** the evidence still does not identify the fake-shop operator and does not support accusing IMEDIA, ZION/ZaloPay, or any named individual. The correct investigative request is provider-side preservation and lawful disclosure of merchant onboarding/KYC, account-linkage, order, risk, and settlement records for `app_id=4982` / `Z397926244101696205`.

## Relationship to existing dossier

This note strengthens the existing caveat in `REPORT.md` and `lawful_action_packet.md`: `IMEDIA JSC` is a payment receiver/display label and app 4982 is an integration identifier, not a perpetrator finding. It does not add a new public suspect or support an arrest request against IMEDIA or its staff.
