# Tucows (and Enom) abuse reporting

Researched 2026-11-20 in one persistent remote Chrome (`fabric up --remote --name tucows`, patchright over CDP). No report was filed: every request that would file one was aborted with `page.route(...).abort()`.

## Channel

Mail is dead. `domainabuse@tucows.com` / `abuse@enom.com` auto-reply "not monitored". The live channel is a web form.

- Tucows Family of Registrars (Ascio, **Enom**, EPAG, OpenSRS): https://tucowsdomains.com/report-abuse/ (WordPress info page). Every "abuse reporting form" / "this link" on it points to **https://bullwark.tucows.com/report** (8 links, all identical). Page text: "All abuse can be reported by using this link", "we will respond with an acknowledgement of receipt, including a case number. Tucows uses Freshdesk to track reports." Phishing section: "To report phishing or pharming involving a Tucows domain name, submit a report via our abuse reporting form." Tucows then "expeditiously reset[s] its Name Servers" or works with the registrant.
- Enom has a **second, legacy form**, still live: `https://www.enom.com/help/abusepolicy.aspx` (redirects to `cp.enom.com//help/abusepolicy.aspx`, ASP.NET WebForms, "Enom uses Zendesk to track requests"). Enom's help article (https://support.enom.com/support/solutions/articles/201000130069-report-domain-abuse-to-enom) names exactly this form plus `abuse@enom.com`, and says "You may not receive a reply or status update unless additional information is needed." So for Enom-registered domains: the Enom form works and is simpler; the Tucows (bullwark) form also accepts Enom domains (`enom.com` and `tucows.com` validate as registered through Tucows; see Fields). The mail `abuse@enom.com` auto-reply claim is consistent with the help article now preferring the form.
- API: none public. Searched (web, JS bundle): no docs, no auth, no rate limit information. `/openapi.json`, `/docs`, `/api`, `/robots.txt` on bullwark are 404. The form's own JSON endpoints under `/api/user/*` are internal (CSRF + session cookie).
- Third-party confirmation: phish.report (https://phish.report/contacts/tucows/) says the best way to report is the tucowsdomains.com form (Tucows is IANA registrar 69 and AS15348 hosting; hosting abuse mail `arin-abuse@tucows.com`).

## Access (login/captcha)

Bullwark (`bullwark.tucows.com`, Go-style server with Alpine.js front end, `Set-Cookie csrf_token` HttpOnly Secure SameSite=Strict, Ketch consent banner):

- **No account.** "No account required." Identity = name + email, verified by a **6-digit mailed code**.
- **Captcha: Cloudflare Turnstile** on step 1 only. Sitekey `0x4AAAAAADhWTmUwriZtddpv`, `data-size="flexible"`, response field `cf-turnstile-response` (794-char token, prefix `1.`). In the real remote Chrome it solved itself with no interaction in a few seconds (managed/non-interactive). CSP allows `challenges.cloudflare.com` only. Plain HTTP needs a Turnstile token: DeathByCaptcha already handles Turnstile (`death_by_captcha.ts` line ~135, used by the cloudflare provider).
- **Mailed code**: sender `noreply@bullwark.tucows.com`, subject `Your verification code`, text "Use the code below to verify your identity on the Tucows Domains abuse report form." then a bare 6-digit code (example `364971`), "Expires in 15 minutes". Arrived in ~10 s. Suitable for `mailed_code.ts`: `senderDomains: ["bullwark.tucows.com"]` (or `tucows.com`), `subjectPattern: "your verification code"`, `codePattern: "\\b(\\d{6})\\b"` (the copyright line has no 6-digit run; first 6-digit group in the body text is the code; verify against the HTML part, which has a 3053-char body). Resend: `POST /api/report/resend-otp` with header `X-CSRF-Token`, 60 s cooldown.
- No captcha on later steps.

Enom legacy form: no login; **image captcha** (`/captchautil/Captcha.aspx?annc=<id>`, JPEG 230 px wide, case-sensitive text, DeathByCaptcha image). Its answer is validated by an unauthenticated oracle: `GET /captchautil/validatecaptcha.aspx?cap=<hdnCaptcha>&ans=<answer>` returns `true`/`false` (wrong answer verified: `false`). Useful to confirm the solve before the real submit.

## Fields

### Bullwark flow (server-driven wizard, session cookie `_swb` + `csrf_token`)

| Step | Request | Fields |
|---|---|---|
| 1 `GET/POST /report` | `application/x-www-form-urlencoded`, 303 -> `/report/otp` | `csrf_token` (hidden, per page), `name` (required), `email` (required), `organization` (optional), `role` (optional: `legal`, `it_security`, `compliance`, `brand_protection`, `other`), `cf-turnstile-response` |
| 2 `POST /report/otp` | urlencoded, 303 -> `/report/types` | `csrf_token`, `code` (6 digits). Page has 6 one-digit inputs, JS joins them into hidden `code` |
| 3 `POST /report/types` | urlencoded, 303 -> `/report/form` | `csrf_token`, `category_id` (radio UUID), `ai_suggestion_accepted` (`false`/`true`) |
| 4 `POST /report/form` | **multipart**, the filing request | see below |

Category UUIDs (slug -> id): `domain-phishing-pharming` -> `00731b3c-389e-4c7a-8df6-2c3718d4b2a9` (**use this for phishing**), `malware-botnets` `8d9fd405-4bc3-4d43-a859-58f0a848189c`, `spam` `30e79c57-4816-4ee5-9a50-2a135816dc1c`, `illegal-pharmacy` `4206f7c7-5639-4dca-9181-d2ec25615d1d`, `domain-name-hijacking` `d2b91c48-514d-4d27-89f0-7e3dbb2adf43`, `intellectual-property` `5519c5fa-2651-48c0-90e9-c07577b6342d`, `other-illegal-activity` `93a16e6b-6b7d-42cb-81eb-e50ba987323e`, `email-phishing` `22d6a45d-cf5e-436c-b714-562d20ee3884`. The "Abuse Detector" (AI, optional) is `POST /api/user/suggest-category`.

Phishing form (`category_id` 00731b3c…), all in `POST /report/form`:

| name | label | required | values / limits |
|---|---|---|---|
| `csrf_token` | hidden | yes | from the form page |
| `is_domain_owner` | Are you the Domain Owner? | no (radio) | `Yes` / `No` |
| `offending_domain` | Offending domain name | yes | text; server-validated, see below |
| `target_group` | Brand Group | yes | free text (brand name) |
| `target_group_domain` | Brand domain | yes | text, no live validation |
| `url` | URL of page with offending content | yes | `type=url`, pattern `[Hh][Tt][Tt][Pp][Ss]?://.+`; full path expected |
| `description` | Your message | yes | textarea, no `maxlength` attribute (Enom's form: 8000 chars) |
| `file_upload` | Supporting evidence | **yes** | multipart file, **max 5 files, 10 MiB each (10485760), 20 MiB total (20971520)**; no `accept` attribute, repeated field name for several files; I only tested a JPEG (type restrictions beyond that unknown) |
| `attest_good_faith` | affirmation | yes | checkbox, value `on` |
| `attest_data_processing` | privacy consent | yes | checkbox, value `on` |

Internal JSON endpoints used while filling (all need header `X-CSRF-Token: <meta name="csrf-token" content>` plus the session cookie; they never file anything):

- `POST /api/user/validate-field` (urlencoded `field_name`, `value`) -> `{"valid":bool,"error"?:..,"info"?:..,"derived"?:..}`. For `offending_domain` this does a registrar lookup:
  - `google.com` -> `{"valid":false,"error":"google.com is not registered through Tucows (registrar: MarkMonitor Inc.) — abuse contact: abusecomplaints@markmonitor.com"}` (**the form blocks non-Tucows domains client-side and tells you the real registrar abuse contact**; whether the server re-checks on submit is untested).
  - `tucows.com`, `enom.com`, `sub.opensrs.com`, `https://www.enom.com/x` -> `{"valid":true}` (URLs are normalized to a host).
  - unregistered `*.com` -> valid with info "We couldn't find a registration for …"; `example.invalid` -> valid with info "That TLD isn't on the IANA root list".
- `POST /api/user/check-duplicate` (JSON `{category_id, fields:{offending_domain}}`) -> `{"hard":false,"reference_number":null,"soft":false}`. `hard:true` returns the existing case `reference_number` ("An active report already exists for this domain and category (REF)"); the form still allows resubmitting.
- `POST /api/user/evaluate-category` (JSON `{text, category_id}`, text = all field values joined by newlines) -> `{"match":true,"chosen_category":{...},"popup_title":"Category confirmed",...}`; if the AI disagrees, a popup offers to switch category. Called when "Next" is clicked; on any error the client proceeds anyway. Not required for the server (just a UI gate before `requestSubmit()`).

### Enom legacy form (`POST /help/abusepolicy.aspx`, multipart ASP.NET WebForms)

| name | label | required | notes |
|---|---|---|---|
| `ctl00$Main$txtEmailAddress` | Your email address | yes | |
| `ctl00$Main$txtDomainName` | Domain Name used for DNS Abuse | yes | |
| `ctl00$Main$taMessage` | complaint + evidence | yes | 8000 chars max |
| `ctl00$Main$fileUploadJpg` | attach evidence (optional) | no | `accept="image/jpeg"`, one file |
| `ctl00$Main$captcha` | case-sensitive image text | yes | image captcha |
| `ctl00$Main$hdnCaptcha` | hidden captcha id | yes | value = `annc` in the image URL |
| `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`, `__RequestVerificationToken`, `__EVENTTARGET=ctl00$Main$btnSend`, `__EVENTARGUMENT`, `ctl00_ScriptManagerPlaceHolder_ScriptManager1_HiddenField`, `ctl00$ScriptManagerPlaceHolder$ScriptManager1` | hidden | | scrape from the GET page |

Submit button is `<a id="ctl00_Main_btnSend" href="javascript:WebForm_DoPostBackWithOptions(...)">` with client validation (including the captcha oracle above); a direct POST with `__EVENTTARGET=ctl00$Main$btnSend` is what the page submits.

## Submit request (exact captured payload, aborted)

Bullwark, filing request (headers minus cookies; boundary random per request):

```
POST https://bullwark.tucows.com/report/form
content-type: multipart/form-data; boundary=----WebKitFormBoundaryK9BXX36mcILtWxrl
origin: https://bullwark.tucows.com
referer: https://bullwark.tucows.com/report/form
cookie: csrf_token=…; _swb=…; (session + Ketch consent cookies)

------WebKitFormBoundaryK9BXX36mcILtWxrl
Content-Disposition: form-data; name="csrf_token"

<hidden csrf from the form page>
Content-Disposition: form-data; name="is_domain_owner"            -> No
Content-Disposition: form-data; name="offending_domain"           -> example.invalid
Content-Disposition: form-data; name="target_group"               -> Example Brand
Content-Disposition: form-data; name="target_group_domain"        -> brand.example
Content-Disposition: form-data; name="url"                        -> https://example.invalid/login
Content-Disposition: form-data; name="description"                -> Placeholder test text, not a real report.
Content-Disposition: form-data; name="file_upload"; filename="ev.jpg"   (Content-Type: image/jpeg, JPEG bytes)
Content-Disposition: form-data; name="attest_good_faith"          -> on
Content-Disposition: form-data; name="attest_data_processing"     -> on
```

There is **no separate pre-upload or token call**: the files travel in this one multipart request. The only pre-submit calls are the `/api/user/*` helpers above (optional).

Earlier steps (all really sent except step 1's first attempt, which was aborted once; the second let ONE code mail through to support@phishing.support, with the user's approval):

```
POST /report               csrf_token=<hidden>&name=Phishing+Support&email=support%40phishing.support&organization=&role=&cf-turnstile-response=<794-char token>   -> 303 /report/otp
POST /report/otp           csrf_token=<hidden>&code=364971                                                                                                        -> 303 /report/types
POST /report/types         csrf_token=<hidden>&ai_suggestion_accepted=false&category_id=00731b3c-389e-4c7a-8df6-2c3718d4b2a9                                       -> 303 /report/form
```

The CSRF value is a base64 token, per page (the `<input name=csrf_token>` value and `<meta name="csrf-token">` differ in format from the cookie of the same name; the `/api/*` calls use the meta value in `X-CSRF-Token`). Redirect targets reveal the state machine: `/report` -> `/report/otp` -> `/report/types` -> `/report/form` -> (not observed) a "Submit Report"/"Confirmation" step; the stepper reads "Verify Email · Select Type · Submit Report · Confirmation". `POST /report/restart` ("Start over") resets the session.

Enom legacy form, captured (aborted), fields in order: `ctl00_ScriptManagerPlaceHolder_ScriptManager1_HiddenField=`, `__EVENTTARGET=ctl00$Main$btnSend`, `__EVENTARGUMENT=`, `__VIEWSTATE=<opaque>`, `__VIEWSTATEGENERATOR=8EA51FF8`, `__EVENTVALIDATION=<opaque>`, `__RequestVerificationToken=<token>`, `ctl00$ScriptManagerPlaceHolder$ScriptManager1=`, `ctl00$Main$txtEmailAddress=placeholder@example.invalid`, `ctl00$Main$txtDomainName=example.invalid`, `ctl00$Main$taMessage=…`, `ctl00$Main$fileUploadJpg` (filename `t.jpg`, `image/jpeg`), then `ctl00$Main$captcha`, `ctl00$Main$hdnCaptcha`. Content-Type `multipart/form-data`, POST to `https://cp.enom.com//help/abusepolicy.aspx` (same path as the GET). Origin/referer `https://cp.enom.com`.

## Receipt & status

Not observed (it requires actually filing). From the docs only:

- Tucows: "respond with an acknowledgement of receipt, including a case number" tracked in **Freshdesk**; the quarterly report link is mailed too. The check-duplicate API exposes `reference_number` of existing active reports, so the case reference is a string (format unknown). Confirmation mail sender/subject unknown; expect a Freshdesk-style ticket mail (and the bullwark noreply sender). The form says it records "the site and the category, date, and resolution" internally; personal data is not stored there.
- Enom (legacy): "Enom uses Zendesk"; "We will not contact you unless we need more information"; no ticket/status guaranteed.
- Status later: no public status page or API found. The only lookup is the duplicate check (does a report exist for domain+category, returning `reference_number`).

## Automation plan

Provider design: HTTP all the way except possibly Turnstile, no browser needed.

1. `GET /report`: collect cookies (`csrf_token`, `_swb`), hidden `csrf_token`, meta CSRF.
2. Solve Turnstile (sitekey `0x4AAAAAADhWTmUwriZtddpv`, page `https://bullwark.tucows.com/report`) via DeathByCaptcha; `POST /report` (urlencoded) with a stable reporter identity (`Phishing Support` / `support@phishing.support`, role `it_security`, organization `Phishing Support`). Record the request time.
3. Read the code with `mailedCodeReader` (spec above), `POST /report/otp`.
4. `POST /report/types` with the phishing category id.
5. `GET /report/form` (new CSRF), optional `validate-field` on `offending_domain` as a **registrar pre-check** (reuse its error: it names the real registrar abuse contact, so a non-Tucows domain can fall back to that contact instead of being filed here), optional `check-duplicate` to skip a domain with an active case (`hard:true` carries the reference).
6. `POST /report/form` multipart with the fields above; evidence screenshot(s) as `file_upload` (required, so every report needs at least one file; 10 MiB each, 5 files, 20 MiB total; JPEG verified, PNG likely, untested).
7. Parse the 2xx/303 result page for the case number.

Enom-only fallback: `GET` the ASP.NET page, solve the image captcha (DeathByCaptcha), verify with the `validatecaptcha.aspx` oracle, POST multipart with scraped hidden fields. Simpler, but no confirmation is promised. Given bullwark accepts Enom domains, prefer bullwark for everything.

Risks:

- Turnstile token acceptance via DBC for this widget (`flexible`, non-interactive in Chrome) is unproven. A real Chrome gets a token automatically in seconds, so a browser fallback (open page, wait for `cf-turnstile-response`, then do the rest over HTTP with the cookies) is cheap if DBC fails. Tokens are single-use and bound to the page/IP; solve from the same egress.
- One OTP mail per report (15-minute expiry, 60 s resend). Throttling of OTP requests/IP unknown. The session after step 3 can probably file multiple reports (the "Start over" button suggests one report per session: untested).
- Evidence upload is mandatory; the server's allowed types/size are only enforced client-side to my knowledge.
- Server may re-validate registrar (Tucows-only) at submit; client does `validate-field` blocking.
- Hidden anti-abuse: `ai_suggestion_accepted`, the AI category gate. A phishing description that the Abuse Detector scores as another category only shows a popup client-side.
- The 303 flow depends on server-side session state; a failed step needs `POST /report/restart` then restart.

## Open questions

- Confirmation page text, case-number format, confirmation mail sender/subject (needs one real filing; nothing found in docs).
- Whether `/report/form` POST enforces "Tucows-registered domain" server-side and whether reports for hosted-only content (not registered at Tucows) are rejected. Docs: only registrar abuse (Tucows "cannot help you with requests regarding content"; it resets nameservers). Registrar case is clearly the intended one; hosting (Tucows AS15348) uses `arin-abuse@tucows.com` per phish.report, untested.
- Allowed evidence types beyond JPEG, and whether several `file_upload` parts are accepted by repeating the name (the dropzone is `multiple`, so presumably yes).
- Rate limits / daily caps per email, IP or domain; any status endpoint after filing.
- Whether `target_group_domain` is validated server-side and what `derived` values `validate-field` can return (none seen).
