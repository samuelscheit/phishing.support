# Newfold Digital (Bluehost, HostGator, Network Solutions, Web.com, Register.com, …)

Researched 2026-11-20 with a remote Chrome (fabric, `recipe_chrome@1`, direct egress). Nothing was submitted: the submit request was aborted client-side with `page.route(...).abort()`.

## Channel

- Single official channel: web form **https://www.newfold.com/abuse** ("Report Abuse", AEM page). Mail is not monitored.
- HostGator KB (https://www.hostgator.com/help/article/where-can-i-report-abuse-and-or-spamming): "Abuse department must be contacted directly via our abuse form and resolved through the ticket process … Chat and Phone support … may not directly assist … We may not be able to provide you with specific updates regarding your report for privacy reasons."
- Form page text: "Once submission of an abuse report is received, we will create a unique case ID in our system … referenced in any subsequent correspondence to you … we may not be able to provide you with specific updates."
- Covers every brand in the `brand` dropdown (below), registrar and hosting alike. Phish.report lists the same form for Unified Layer (Bluehost), FastDomain, Network Solutions Hosting.
- WHOIS/ASN mailboxes (`abuse@bluehost.com`, `IARPOC@Newfold.com`, `net-eng-team@newfold.com`) are the dead mail path. The only other address found in the page source: hidden field `inquiryEmail=abuse-trademark@newfold.com` (internal routing value, default for the form; not a public mailbox) and `grievance-officer@newfold.com` (India grievance officer only). No other abuse mailboxes are published.
- No public API, docs, auth or rate limits exist. The form posts to an internal AEM servlet (below); a third party reports reCAPTCHA failures/unresponsive button at times (https://medium.com/@0xFFF/when-your-mom-gets-phished-an-incident-response-walkthrough-987a9950a342).

## Access (login/captcha)

- No login/account. Anonymous.
- Cloudflare in front of `newfold.com`: plain `curl` gets an interactive "Just a moment…" challenge (`/abuse`) and 403 on `/libs/granite/csrf/token.json`. The remote Chrome passed without any interaction (www.newfold.com/abuse loaded directly). Plain HTTP needs cf_clearance, so HTTP-only is not realistic without a browser warm-up.
- Captcha: **Google reCAPTCHA v2 checkbox** ("I'm not a robot", `size=normal`, explicit render), **sitekey `6Lc2vj8lAAAAAF4yi77gg_-kxh2q4FyIBHUK9pES`**, page URL `https://www.newfold.com/abuse`. Clicking the checkbox from the datacenter browser immediately showed the image challenge (bframe visible, token empty) → needs the image challenge solved. Implemented: Browser Fabric's solver (llm-captcha, with Fabric's own DeathByCaptcha fallback) passes it in the page that files; the app only waits for `data-captcha-state` and reads the token.
- Client-side validation only requires the `g-recaptcha-response` textarea length ≥ 50 (script "MIN_RECAPTCHA_LENGTH"); server validation of the token is unverified (we never submitted).
- No email verification step before the case is created; the reporter's email is just a field.
- OneTrust cookie banner overlays the form (`#onetrust-consent-sdk`); it intercepts clicks, remove it or accept it.

## Fields

Form: `<form method="POST" action="/bin/newfold/lead" enctype="multipart/form-data">` (native submit, no XHR; id is renamed by JS, originally `abuseForm`). Client validation validates the FormData and also rejects changed hidden values / option values.

| name | type | required | notes |
|---|---|---|---|
| `firstName` | text | yes | |
| `lastName` | text | yes | |
| `email` | email | yes | regex `^[^\s@]+@[^\s@]+\.[^\s@]+$` |
| `url` | url ("Domain*") | yes | must parse as URL with a dot in host; scheme optional in validator (placeholder `https://web.com`) |
| `inquiryType` | select (custom dropdown sets it) | yes | see values |
| `brand` | select | yes | see values |
| `comments` | textarea | yes | `maxlength=1000`, `wrap=hard` (validator strips CR/LF before counting 1000) |
| `attachment` | file | no | one file, ≤ 1 MB (1048576), ext png/jpg/pdf/doc/docx/txt (accept also allows xml; validator does not) |
| `agreementStatement` | checkbox | yes | sent as `on`; "I hereby represent and warrant that all statements … are truthful and accurate." |
| `g-recaptcha-response` | textarea | yes | reCAPTCHA token |
| `inquiryEmail` (hidden) | | | `abuse-trademark@newfold.com` (constant, even for Phishing; must not change) |
| `newfoldAbuse` (hidden) | | | `newfoldAbuse` |
| `requestJSONPath` (hidden) | | | `/content/dam/newfold/esb/abuse.json` |
| `thankyou` (hidden) | | | `https://www.newfold.com/thank-you` |

`inquiryType` values: `ABUSE-FORM-0001` Adult Content or CSAM, `0002` Copyright Infringement, `0003` Domain Protected by Privacy or Statutory Masking, `0004` Fraudulent business scheme, `0005` Inappropriate/Violent/Offensive Content (also the value for Invasion of Privacy in the select), `0006` Invalid or inaccurate Whois information, `0007` Malware, **`0008` Phishing**, `0009` Rogue pharmacy, `0010` Software piracy, `0011` Spam, `0012` Trademark Infringement, `0020` Subpoena Request. (RDDS Request appears in the visible dropdown but not in the validated select; skip.) Note: the visible dropdown lists Privacy Invasion as `ABUSE-FORM-0005` as well as Inappropriate Content.

`brand` values: `808-accountsupport` AccountSupport.com, `287-arvixe`, `288-aso` A Small Orange, `800-bluehost`, `160-crazydomains`, `Domain.com` (no value attr → value is the text), `172-dreamscape`, `163-freeparking`, `Homestead` (text), `150-hostgator`, `258-hostyoursite`, `250-ipage`, `100-namejet`, `300-namesecure`, `Netfirms` (text), `100-networksolutions.com`, `200-register.com`, `292-sites` Site5, `100-snapnames`, `300-srsplus`, `170-vodien`, `300-web.com`, `279-yourwebhosting`, `100-other`.

Server-side field map (publicly readable `GET /content/dam/newfold/esb/abuse.json`, the `requestJSONPath` template): creates a CRM case:

```json
{"RequestType":"Create","Subject":"API case creation","CaseDescription":"@comments","APIIdentifier":"@inquiryType",
 "Customer":{"PlatformID":"AbuseForm","newBrandId":"@brand","newPlatformId":"","Email":"@email","FirstName":"@firstName","LastName":"@lastName","PrimaryPhoneNumber":"","AccountID":"","ContactId":"AbuseFormContact-Newfold","FullName":"@fullName"},
 "Product":{"Domain":"@url","ProductInstanceID":""},"Attachments":"@attachment"}
```

So the brand picks the platform/queue; the reporter's `comments` become the case description. Put the URL(s), evidence summary in `comments` (1000 chars).

## Submit request (exact captured payload)

Preceded only by `GET /libs/granite/csrf/token.json` (Granite CSRF client lib; its token is not added to the native-form body in this capture, no `:cq_csrf_token` field, no CSRF header). No upload/token pre-calls. Captured (aborted):

```
POST https://www.newfold.com/bin/newfold/lead
content-type: multipart/form-data; boundary=----WebKitFormBoundaryCQcAytRH2Jr4x0fL
origin: https://www.newfold.com
referer: https://www.newfold.com/abuse
cookie: geo=EU; AMCV…; OptanonConsent=…; (analytics cookies only; no session/CSRF cookie)
user-agent: Mozilla/5.0 (X11; Linux x86_64) … Chrome/157.0.0.0 Safari/537.36

firstName=Test
lastName=Placeholder
email=test@example.com
url=https://example.com/login
inquiryType=ABUSE-FORM-0008
brand=800-bluehost
comments=Placeholder phishing report text.
attachment; filename="ev.txt"; Content-Type: text/plain   (body: hello placeholder evidence)
agreementStatement=on
g-recaptcha-response=<60 x "X" placeholder>
inquiryEmail=abuse-trademark@newfold.com
newfoldAbuse=newfoldAbuse
requestJSONPath=/content/dam/newfold/esb/abuse.json
thankyou=https://www.newfold.com/thank-you
```

(multipart parts in exactly that order; part for empty `attachment` when no file is probably a zero-size file part, as for any native form.) The response was not observed (aborted). Expected: 302 → `https://www.newfold.com/thank-you`.

## Receipt & status

- `https://www.newfold.com/thank-you` text: "Thank you for submitting an 'Abuse' form — Someone will be in touch with you shortly". No case ID is shown there.
- Case ID: created server-side ("unique case ID … referenced in any subsequent correspondence"); format unknown, presumably sent by email to the reporter's address. Sender/subject of the confirmation mail not documented; unverified (needs a real submission).
- No status lookup; "may not be able to provide you with specific updates".

## Automation plan

- Browser required for transport: Cloudflare interactive challenge on newfold.com blocks curl; recaptcha v2 needs a token bound to `www.newfold.com`.
- Recommended: drive the remote browser (cf passes), open `/abuse`, remove OneTrust banner, fill fields with `fill`/`selectOption` (set `#inquiryType` select directly; the custom dropdown just writes it), `setInputFiles` for the screenshot, check `#agreementStatement` (force), let Browser Fabric's solver pass the reCAPTCHA v2 in the page (keep the widget in view, the OneTrust banner hidden) and read its token from `#g-recaptcha-response` once `data-captcha-state` says solved, click `#reportAbuse`, wait for `/thank-you`.
- Alternative hybrid: use the browser only to obtain cf cookies + UA, then POST the multipart above with fetch from the page context (`page.evaluate(fetch(...FormData))`) – avoids DOM quirks; same-origin, no CSRF token needed as captured.
- Brand mapping: use registrar/host name → brand value (Bluehost `800-bluehost`, HostGator `150-hostgator`, Network Solutions `100-networksolutions.com`, Web.com `300-web.com`, Register.com `200-register.com`; unknown Newfold network → `100-other`). Inquiry = `ABUSE-FORM-0008`.
- Risks: v2 image challenge (the solver's image rounds and Fabric's fallback can take minutes; the token then lives about two minutes), server may validate the token and Cloudflare/geo (`geo=EU` cookie seen), comments limit 1000, attachment ≤ 1 MB (png/jpg/pdf/doc/docx/txt), no machine-readable receipt (case ID only by email → use mailed-code style inbox parsing for the confirmation), reports may be silently dropped ("someone will be in touch").

## Open questions

- Real response/redirect and whether server verifies the reCAPTCHA token (needs one real submission, intentionally not done).
- Confirmation mail sender, subject and case ID format.
- Whether the same form is accepted when Newfold is registrar only vs host only: the form is brand-based and has a "Domain Protected by Privacy…" type plus Whois/RDDS types, so registrar-side cases are in scope (ICANN text on page: "act … when required … if an activity violates the policies of ICANN or appropriate registry"); hosting-only (Bluehost shared hosting on third-party-registered domains) is selected via the hosting brand. No explicit rule separating them.
- Whether `url` accepts a bare hostname and multiple URLs.
