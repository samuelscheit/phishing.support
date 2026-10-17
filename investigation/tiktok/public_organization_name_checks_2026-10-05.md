# Public organization/name checks for campaign labels (2026-10-05)

## Scope

This is a narrow, public-only organization check. It searched the **Vietnam National Business Registration Portal** and its public information service for exact business-name variants corresponding to campaign root-domain labels. It also checked exact campaign-domain strings against indexed public company/brand pages. No personal names, addresses, telephone numbers, social profiles, leaked material, or private data were searched.

- Registry homepage: <https://dangkykinhdoanh.gov.vn/vn/Pages/trangchu.aspx>
- Registry public information service: <https://dichvuthongtin.dkkd.gov.vn/inf/default.aspx>
- Sanitized query/result capture: [`public_organization_registry_checks_2026-10-05.json`](public_organization_registry_checks_2026-10-05.json)

The registry's autocomplete results were retained only as organization names, English names, and public enterprise identifiers. Session parameters and addresses were not retained.

## Results

### Positive registry name matches — lexical only

These are public organizations whose names contain the same ordinary words as a campaign label. The registry result does **not** claim any campaign domain, and no exact campaign-domain operation was found.

| Campaign label | Public registry result | Public identifier(s) | Interpretation |
|---|---|---|---|
| `hungdungmedia` | CÔNG TY CỔ PHẦN TRUYỀN THÔNG VÀ GIẢI TRÍ HÙNG DŨNG / HUNG DUNG MEDIA AND ENTERTAINMENT JOINT STOCK COMPANY | Enterprise code `0012576773`; GDT code `0106917491` | Name match only; no claim to `hungdungmedia.fun` found. |
| `hoanghaimedia` | CÔNG TY TNHH HOÀNG HẢI MEDIA / HOANG HAI MEDIA COMPANY LIMITED; two additional distinct Hoàng Hải media-name entities were also returned | Enterprise codes `0033764464`, `0012893590`, `0021557153` | Multiple legitimate name matches make the domain token non-unique; no claim to `hoanghaimedia.shop` found. |
| `kimsonmedia` | CÔNG TY CỔ PHẦN TRUYỀN THÔNG KIM SƠN / KIM SON MEDIA JOINT STOCK COMPANY | Enterprise code `0005687012`; GDT code `0104521310` | Name match only; public brand evidence points to `KSSHOP.VN`, not `shop-xu.kimsonmedia.sbs`. |
| `dainammedia` | Multiple Đại Nam media-name entities, including DAI NAM MEDIA COMPANY LIMITED and related media companies | Multiple public enterprise/GDT codes | Common words and multiple entities; no claim to `dainammedia.space` found. |
| `hd-media` | Multiple HD MEDIA entities | Multiple public enterprise/GDT codes | Generic initials/name; no claim to `hd-media.space` found. |
| `taki-media` | CÔNG TY TNHH TRUYỀN THÔNG TAKI MEDIA / TAKI MEDIA LIMITED LIABILITY COMPANY, plus other Taki media-name results | Enterprise code `0021367974`; GDT code `3301666342` (for the exact result) | Name match only; no claim to `takimedia.shop` found. |
| `ko-media` | CÔNG TY CỔ PHẦN TRUYỀN THÔNG KOS / KOS MEDIA JOINT STOCK COMPANY | Enterprise code `0021825964`; GDT code `0109130751` | `KOS` is not `KO`; lexical proximity is not attribution. |
| `huuhanstudio` | No exact HUU HAN STUDIO result; a distinct STUDIO CHS result appeared for the spaced query | Enterprise code `0014669949`; GDT code `3700585977` | Not an exact organization-name match; no claim to `huuhanstudio.space` found. |

### No registry result for the searched label variants

No public autocomplete result was returned for the searched variants of `caothaisonmedia`, `aoanh-media`, `quangthaimedia`, `quanghung-media`, `thuytongstore`, `sonhaimedia`, `thuynmedia`, `vntik`, or `orvantis`.

“No result” means only that the public registry search returned no matching organization for the submitted query variants. It is not proof that no organization, private registrant, or informal brand exists.

## Public company/brand page check

The official BCTech website identifies **KSSHOP.VN** as “the online sales website of Công ty Cổ phần Truyền thông Kim Sơn (Kim Sơn Media).” It does not identify or link `shop-xu.kimsonmedia.sbs`, `kimsonmedia.sbs`, or any other campaign domain. See the company page at <https://bctech.vn/> (the KSSHOP/Kim Sơn statement appears in the projects section).

Exact-domain searches for the following campaign labels produced no indexed official-company/brand claim in this pass: `hungdungmedia.fun`, `quangthaimedia.shop`, `quanghung-media.site`, `hoanghaimedia.shop`, `thuytongstore.fun`, `takimedia.shop`, `aoanh-media.space`, `caothaisonmedia.shop`, and `kimsonmedia.sbs`.

## Assessment

**No registered public organization was found that directly claims or operates a campaign domain.** The positive registry results are ordinary lexical name matches. The strongest related public-brand result is a legitimate Kim Sơn Media project (`KSSHOP.VN`) on BCTech's site; it is a different domain from the campaign's `shop-xu.kimsonmedia.sbs`.

This check does **not** identify the operator and does not establish that any matched organization knowingly participated. Provider account records, registrar records, server logs, payment KYC/settlement records, or lawful investigative process would be needed for attribution.
