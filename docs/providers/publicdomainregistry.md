# PublicDomainRegistry (PDR) abuse reporting

Researched 2026-11-20 (live form explored in a remote Chrome via fabric; submit never sent).

## Channel

- Mail to `abuse@` / `abuse-contact@publicdomainregistry.com` is not monitored. Official page https://publicdomainregistry.com/process-for-handling-abuse/ routes everything through web forms: Phishing, Spam, Malware, Counterfeit, Harmful viewer content, Invasion of privacy, IP infringement, Scam website, Rogue pharmacy, Other unlawful.
- Phishing form: **https://publicdomainregistry.com/phishing/** (WordPress + Contact Form 7 v6.2.4.1, form id 643, post 645). Same URL is listed by phish.report.
- Page text: "Once submission of an abuse report is received, we will create a unique case ID in our system that we will use to track the report. This unique ID will be referenced once we respond"; "In case of deliberate phishing / 419 scam / Malware distribution, the domain name will be suspended directly"; "we may not be able to provide you with specific updates … due to privacy reasons"; spam orgs with many cases may attach a spreadsheet to the form.
- No public API found (no docs, no auth, no documented rate limits). The only machine surface is the CF7 REST endpoint the form itself uses.

## Access (login/captcha)

- No login/account required.
- **Cloudflare managed challenge on the whole site** ("Just a moment…", `cf-mitigated: challenge`, HTTP 403 for curl on `/phishing/`, `/wp-json/...`; `admin-ajax.php` answers 400 without challenge but needs the nonce from the page). Plain HTTP cannot even load the form. In the fabric Chrome the challenge solved itself in ~10 s without interaction (sets `cf_clearance`).
- **Cloudflare Turnstile** on the form: sitekey `0x4AAAAAACAtS6b3TkGjyDhX`, action `contact-form-7`, appearance always, size normal. It solved automatically (non-interactive) in the real browser, token ~800 chars, but **only renders once the widget is scrolled into view** (`document.querySelector('.cf-turnstile').scrollIntoView()`); without scrolling no iframe is created and the token stays empty. Token is posted as `cf-turnstile-response`. DBC is not needed in the browser path.
- OneTrust cookie banner overlay blocks clicks until dismissed (`#onetrust-reject-all-handler`). Use `evaluate(e=>e.click())` on the checkbox or reject the banner first.
- No email verification / mailed code before submission.

## Fields

POST fields of CF7 form 643 (`maxlength` from HTML):

| name | label | required | limits |
|---|---|---|---|
| `your-name` | Your Name | no | text, max 400 |
| `text-748` | Domain Name | **yes** | text, max 400 (bolster guide: domain with TLD only, e.g. `abcdefg13.com`) |
| `textarea-66` | Phishing link/(s) & Detailed Complaint | **yes** | max 2000 chars |
| `your-email` | Your Email Address | **yes** | email, max 400 |
| `upload-file-448[]` | Attachment (screenshot with time-stamp) | no | jpg,jpeg,png,pdf,xls,txt,doc,csv; 5 000 000 bytes each; max 10 files |
| `gdpr-privacy-policy[]` | ToS + Privacy Notice consent | **yes** | value `I agree to the Terms of Service and the Privacy Notice` |
| `gdpr-marketing-mails[]` | marketing consent | no | leave unchecked |
| `cf-turnstile-response` | Turnstile | **yes** | |

No category select: the category is the URL (`/phishing/`). Hidden/anti-spam: `_wpcf7`=643, `_wpcf7_version`=6.2.4.1, `_wpcf7_locale`=en_US, `_wpcf7_unit_tag`=wpcf7-f643-p645-o1, `_wpcf7_container_post`=645, `_wpcf7_posted_data_hash`="", honeypot `wpcf7_hp_field` (must stay empty), Akismet behavioural fields `_wpcf7_ak_*`.

CF7 also exposes `GET /wp-json/contact-form-7/v1/contact-forms/643/feedback/schema` and `/refill` (fresh nonces).

## Submit request (captured, aborted via `page.route`)

Upload (done immediately when a file is chosen; this one was allowed through, harmless 178 KB png; the server accepted it and returned the path):

```
POST https://publicdomainregistry.com/wp-admin/admin-ajax.php   multipart/form-data
action=dnd_codedropz_upload  type=click  security=<ajax_nonce from page JS var dnd_cf7_uploader.ajax_nonce, e.g. a0dd4cf355>
hp_field=  form_id=643  upload_name=upload-file-448
upload_folder=<client uuid v4, e.g. 36aa617f-5672-490f-a777-65869197ecf0>
token=<client uuid v4>   upload-file=<binary; filename, Content-Type image/png>
→ 200 {"success":true,"data":{"path":"36aa617f-…","file":"shot.png"}}   (duplicate names get -1, -2 suffix)
```

Submit (aborted, never reached the server):

```
POST https://publicdomainregistry.com/wp-json/contact-form-7/v1/contact-forms/643/feedback
accept: application/json, */*;q=0.1
content-type: multipart/form-data; boundary=----WebKitFormBoundary…
origin: https://publicdomainregistry.com
referer: https://publicdomainregistry.com/phishing/
cookie: cf_clearance (not shown by CDP request headers) + OptanonAlertBoxClosed/OptanonConsent
user-agent: same as the one that solved the CF challenge (clearance is UA/IP bound)

_wpcf7=643
_wpcf7_version=6.2.4.1
_wpcf7_locale=en_US
_wpcf7_unit_tag=wpcf7-f643-p645-o1
_wpcf7_container_post=645
_wpcf7_posted_data_hash=
your-name=Test Reporter
text-748=example.com
textarea-66=Phishing link: https://example.com/login (test, do not act)
your-email=reporter@example.org
upload-file-448[]=36aa617f-5672-490f-a777-65869197ecf0/shot-2.png     (<folder>/<file> from upload response)
cf-turnstile-response=<~800-char token>
gdpr-privacy-policy[]=I agree to the Terms of Service and the Privacy Notice
wpcf7_hp_field=
_wpcf7_ak_hp_textarea=
_wpcf7_ak_js=1795179048749
_wpcf7_ak_bib=  _wpcf7_ak_bfs=1795179074785  _wpcf7_ak_bkpc=0  _wpcf7_ak_bkp=
_wpcf7_ak_bmc=4;  _wpcf7_ak_bmcc=1  _wpcf7_ak_bmk=  _wpcf7_ak_bck=  _wpcf7_ak_bmmc=1
_wpcf7_ak_btmc=0  _wpcf7_ak_bsc=2  _wpcf7_ak_bte=  _wpcf7_ak_btec=0
_wpcf7_ak_bmm=321,812;  _wpcf7_ak_bcc=125,23,50,48;  _wpcf7_ak_bibmac=2
```

(Without the file the `upload-file-448[]` part is simply omitted. `_wpcf7_ak_*` are generated by the Akismet WP script from real mouse/key events; a real browser fills them.)

## Receipt & status

- Not observed (no real submit allowed). CF7 REST response is JSON `{"status":"mail_sent"|"validation_failed"|"spam"|"mail_failed","message":...,"invalid_fields":[...]}`; success message text is site-customised and unknown; page shows it in `.wpcf7-response-output` (form gets class `sent`).
- Per bolster guide: PDR emails a general acknowledgment with a **ticket number** to the submitted email; sender/subject/format not documented anywhere I could find. The page says replies reference the "unique case ID". Expect the mailbox given in `your-email` to receive it → use a dedicated reporter mailbox and parse `case|ticket|ID` from the first reply.
- No public status lookup. Bolster: wait 72 business hours before following up; PDR may decline to give per-report updates.

## Automation plan

- **Browser required** (feasibility: medium). Plain HTTP is blocked by the Cloudflare managed challenge on every route; clearance (`cf_clearance`) is tied to UA/IP and only a real/patched Chrome obtained it automatically. Do: open `/phishing/` in the fabric/patchright browser, wait for the challenge to clear, dismiss OneTrust, fill fields, `setInputFiles` (triggers the admin-ajax upload with the page's nonce), `scrollIntoView` the Turnstile widget and wait for the token, tick `gdpr-privacy-policy[]` via JS click, click Send, then read `.wpcf7-response-output` / `form.dataset.status` (`sent`, `invalid`, `spam`, `failed`).
- Hybrid is possible: after the browser clears CF, export cookies+UA and POST upload+feedback with plain fetch (nonce from `dnd_cf7_uploader.ajax_nonce`, Turnstile token from the page); the Akismet fields make pure-HTTP riskier, so prefer clicking Send in the browser.
- Captcha: Turnstile passed non-interactively; keep a DBC Turnstile fallback (sitekey above, pageurl `https://publicdomainregistry.com/phishing/`) only if the widget goes interactive from datacenter IPs. No slider, no mailed code.
- Risks: CF challenge/Turnstile may harden for datacenter IPs; Akismet may classify as spam (`status: spam`) when behaviour fields are empty/synthetic; no way to get the case ID synchronously (mail-only); site may change the form id/field names (WP plugin); 2000-char limit on complaint (truncate evidence, put the rest in an uploaded `.txt`).
- Scope: abuse form is registrar-side (PDR is a registrar and also hosts some domains): it takes domain-name reports; the IP-infringement category states "only if the infringing domain is hosted with PDR". Phishing needs only the domain registered at PDR (suspension by registrar); no hosting restriction stated for phishing.

## Open questions

- Exact success message and the confirmation mail (sender, subject, case ID format) — needs one real submission; to be verified on the first real report.
- Whether the form validates that the domain is a PDR-registered domain (the input has class `domain-whois-disabled`, suggests a disabled WHOIS check) — untested.
- Does Akismet reject automation-filled submissions? Untested (would require a real send).
- Do duplicate reports for the same domain get deduplicated/throttled? Unknown.
