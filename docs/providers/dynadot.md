# Dynadot abuse reporting (research, 2026-11-20)

Explored in one persistent remote fabric browser (recipe_chrome@1, egress_direct@1, `--fresh` profile; the persistent profile slot was unavailable). Submit requests were intercepted with `page.route` and aborted. Nothing was sent.

## Channel

- Official channel: web form <https://www.dynadot.com/report-abuse> (Nuxt/Vue SPA). Dynadot text: "Dynadot takes all abuse complaints seriously… Due to the volume of complaints we receive, you may not hear back from us unless we require more information from you."
- Email abuse@dynadot.com is the ICANN-published contact. The "mailbox not monitored" auto-reply is not documented by Dynadot; third-party sites still list the mail. The form is the intended channel (the fake-WHOIS help article, <https://www.dynadot.com/help/question/fake-Whois-complaint>, points to the form first).
- Older URL `/report_abuse.html` appears on third-party sites; use `/report-abuse`.
- Types in `select#id-abuse-type-select` (`name=abuse-type`): `1` Spam, `0` Copyright, **`2` Phishing**, `7` Trademark/Cybersquatting, `32` CSAM, `41` NCII, `27` Online Pharmacy, `14` Fake Whois, `11` Defamation, `42` Malware/Botnet. Phishing text: "If the phishing was transmitted via email, please submit … under Spam Abuse." Note: "The website must be live and contain a login area."
- The public API (`https://api.dynadot.com/api3.json?key=…&command=…`, sandbox `api-sandbox.dynadot.com`, 1 request at a time, per-tier limits; <https://www.dynadot.com/domain/api-commands>) is for account/domain management only. It has no abuse command.

## Access (login/captcha)

- No login or account needed. Anonymous cookies only (`session_id`, `lang`, `_cfuvid`, …).
- **Cloudflare managed challenge on the whole site, including the API path.** `curl` on `/report-abuse` and on the submit endpoint returns `403`, `cf-mitigated: challenge` with any UA. A real browser passes it.
- **Cloudflare Turnstile**, sitekey `0x4AAAAAAAGggeDrBKm9XjuG` (in `index-Cn-l7aUx.js`), container `#report-abuse-challenge`, iframe `challenges.cloudflare.com/.../turnstile/.../0x4AAAAAAAGggeDrBKm9XjuG/light/.../normal`. It solved itself in the stealth browser within about 8 s with no click, giving a 794-char token `1.xxxx.yyyy.hash`. Posted as multipart field `cf-turnstile-response`.
- No email verification and no mailed code.

## Fields

Phishing form (`abuse_type=2`). All inputs are `type=text` with `maxlength=255` unless noted. There are no HTML `required` attributes. Required is decided server-side: `is-need` is true in the UI for the first four and the domain fields, and the server returns `validation_errors` plus `highlight_fields`.

| name | label / placeholder | required (UI) |
|---|---|---|
| `full_name_2` | Full Name | yes |
| `email_2` | Email Address | yes |
| `email2_2` | Confirm Email Address (must equal `email_2`) | yes |
| `phone_2` | Phone Number (Optional) | no |
| `domains_2` | Domain Name Involved, "Only one domain allowed" | yes |
| `official_website_2` | Official Website, "Enter 'N/A' if not applicable" | yes (probably) |
| `proxy_locations_2` | VPN/Proxy location(s) and/or user-agent(s) required to view abuse, "Enter 'N/A' if not applicable" | yes (probably) |
| `domain_path_2` | Full Domain Path, "Ex: https://example.com/example/path" | yes (probably) |
| `abuse_file_{i}_2` | Upload Files (Optional) | no |
| `comments_2` | Comments (Optional), textarea, no maxlength | no |
| `cf-turnstile-response` | Turnstile token | yes |
| `save_form_2` | submit button, value `Submit` | – |
| `abuse_type` | appended by JS, `2` | – |

Not verified: which of `official_website_2`, `proxy_locations_2` and `domain_path_2` the server enforces. Verifying needs a real request, which we avoided.

Upload (client code in `index-BSxya6h3.js`, `FileUpload`):

- Up to 8 files by default (`maxFiles`).
- Each file at most 100 MB (104857600 B) and 100 MB in total.
- No `accept` filter, so any type.
- Files go in the same multipart submit, with no pre-upload and no token call. Field names are `abuse_file_0_2`, `abuse_file_1_2`, …

## Submit request (captured, aborted)

```
POST https://www.dynadot.com/dynadot-vue-api/dynadot-service/main-site-api?command=submit_abuse&lang=en
content-type: multipart/form-data; boundary=----WebKitFormBoundary…
accept: */*
origin: https://www.dynadot.com
referer: https://www.dynadot.com/report-abuse
content-language: en
dyna-client-type: Web
cookie: lang=en; session_id=…; _cfuvid=…; (plus analytics cookies; cf_clearance when present)
user-agent / sec-ch-ua*: Chrome 157 (the browser's own)
```

Body parts in order (the blank `phone_2` is sent as an empty string):

```
full_name_2=Test Reporter
email_2=reporter@example.org
email2_2=reporter@example.org
phone_2=
domains_2=example-phish.test
official_website_2=https://example.com
proxy_locations_2=N/A
domain_path_2=https://example-phish.test/login
comments_2=Placeholder test, do not process.
cf-turnstile-response=1.<~790 chars>
save_form_2=Submit
abuse_type=2
```

- No CSRF or other custom token.
- The form handler builds the body from the form's elements (including the submit button) and appends `abuse_type` last.
- Telemetry POSTs to `telemetry.dynadot.com` are irrelevant.

## Receipt & status

- Client logic: the response JSON is `{data:{validation_errors:[...], highlight_fields:[...]}}`. A non-empty `validation_errors` means failure (shown per field, plus `Captcha` for Turnstile). Otherwise the UI shows the green banner **"Submission successful!"**. A thrown error shows "Your submission has failed."
- No case or ticket ID is shown or handled in the client. No confirmation-mail sender or subject is documented, and the page promises no reply. No status lookup exists (anonymous form).
- Success = HTTP OK and `data.validation_errors` empty or absent. The exact JSON shape of success was not captured.

## Automation plan

- **Plain HTTP is not viable.** Every request needs Cloudflare clearance (`cf_clearance` is bound to IP, UA and TLS/JA3 fingerprint) plus a Turnstile token. Pure-Node `fetch` gets `403 cf-mitigated: challenge`.
- Recommended: **hybrid in the stealth browser (patchright/fabric).**
  1. Open `/report-abuse`. Cloudflare clears automatically.
  2. `selectOption('#id-abuse-type-select','2')`.
  3. Fill the `*_2` inputs by `name` (use native fill so Vue's `input` events fire).
  4. Wait until `[name=cf-turnstile-response]` has a value (about 8 s). If Turnstile shows an interactive checkbox, click it, or fall back to a solver token.
  5. Either click `[name=save_form_2]` or `fetch()` the same multipart from `page.evaluate` (same cookies and headers). The submit is one request, so there is no need to reimplement the page.
  6. Read the response from `page.waitForResponse(/command=submit_abuse/)`: success = `validation_errors` empty. Optionally also check for the "Submission successful!" text.
- DeathByCaptcha Turnstile support is unnecessary unless the auto-solve fails in production. If needed, pass the sitekey and page URL, and inject the token into the hidden `cf-turnstile-response` input (or the multipart).
- Risks:
  - Cloudflare may block datacenter or low-reputation egress (this run used `egress_direct@1`).
  - Turnstile may escalate to interactive.
  - The client bundle is hashed and may change; select by `name`, not by class.
  - Per-IP or per-email throttling is unknown.
  - One domain per report; the phishing URL goes in `domain_path_2`.
  - Evidence has no case ID, so we can only record "submitted". Dynadot may never reply.
  - Dynadot's "must be live and contain a login area" policy may cause silent rejection.
- Feasibility: medium (a single-form browser provider; no code needed for slider, mailed code or login).

## Open questions

- The server-side required set and error strings (needs one real or invalid submission; deliberately not sent).
- The exact success JSON and whether a confirmation mail is sent to `email_2`. Test with an inbox we control on the first real report.
- Whether the form is limited to domains registered at Dynadot. The form has no registrar check in the client. Dynadot also resells hosting and website builder services, but there is no separate hosting abuse channel on the page, so registrar and hosting cases share this form. Neither distinction was tested.
- Whether Turnstile stays non-interactive from other egress IPs.
- Whether the mailed abuse@ is read at all. The auto-reply says not, so keep it out of the provider.
