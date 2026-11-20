# Name.com abuse reporting (research)

Researched 2026-11-20 with a remote Chrome (`recipe_chrome-headless@1`, `egress_direct@1`; `recipe_chrome@1` failed to start with "No remote browser became ready" several times) attached by patchright CDP. No report was submitted: the final `POST /ajax/zendeskticket/create/` was aborted with `page.route`. The `verify_recaptcha` call (captcha check only, creates no ticket) was let through once per probe.

## Channel

- Official channel: Report Abuse form at `https://www.name.com/abuse` (also linked as `https://www.name.com/support#abuse`; `/en-us/abuse` renders the same page). Footer: Support → "Report Abuse".
- Law enforcement / consumer protection authorities: phone +1 (303) 459-6012 (footnote on the form).
- `abuse@name.com` is still quoted by third parties (ipzest.app, spam.org) but, per the task, auto-replies "not monitored". The form says nothing about email.
- API: Name.com Core API (`https://docs.name.com`, base `https://api.name.com/core/v1`) is domain management only (domains, DNS, DNSSEC, email forwarding, contact verification, webhooks). Its `llms.txt` index lists no abuse or support endpoint. Auth is HTTP Basic (username + API token, sandbox user gets `-test` suffix). Rate limit 20 req/s per account (429), legacy v4: 20/s and 3,000/h. Requires an account. Useless for reporting.
- Sources: https://www.name.com/abuse, https://docs.name.com/llms.txt, https://docs.name.com/docs/api-overview, https://www.name.com/api-docs, https://ipzest.app/domain-takedown/name-com.
- The form is a Zendesk ticket creator behind Name.com's own Nuxt SPA: the submit endpoint is `/ajax/zendeskticket/create/` with `form-type=report_abuse_spa` (other form types in the same bundle: `general_contact_spa`, `hosting_spa`, `api_support_spa`, `dns_change_spa`, `ssl_contact_spa`).

## Access (login/captcha)

- No login or account required (anonymous session; `GET /api/v5/account/session` returns an anonymous account).
- Whole `www.name.com` is behind a Cloudflare managed challenge ("Just a moment...", interstitial with Turnstile). A plain `curl https://www.name.com/abuse` gets the challenge page. A real Chrome via fabric passes it automatically (headless remote: passed within the first poll; local headless fabric Chrome stayed stuck on it for 25+ s). So HTTP-only needs a `cf_clearance` cookie bound to the same UA/IP; realistically the browser must be used at least to get past it.
- Form captcha: Cloudflare Turnstile, managed/visible widget ("Success!" shown inline above the Submit button), sitekey `0x4AAAAAAD2rWVl7gv-B1cNI` (iframe `https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/.../0x4AAAAAAD2rWVl7gv-B1cNI/light/fbE/new/normal?lang=auto`). It renders only after the three checkboxes are ticked. The hidden inputs are `cf-turnstile-response` and `g-recaptcha-response` (Turnstile compat mode; the server field is still named `supportFormRecaptcha`). Token format `1.<long>.<..>.<hash>`.
- As soon as the widget is solved the SPA calls `POST /api/v5/account/verify_recaptcha`, which sets the session flag `supportFormRecaptcha:true` (visible in the returned account JSON). Whether `/ajax/zendeskticket/create/` rejects a session without that flag was not testable without sending.
- CSRF: header `x-csrf-token-auth`. Obtained by `GET /csrf` with headers `Time: <Date.now()>`, `Start: <uuid>`, `X-csrf-token-auth: sha256(Start+Time+Start)` (hex), `Referrer-Override: <document.referrer>`; the token comes back in the response header `x-csrf-token-auth`. (A bare `fetch('/csrf')` returns 400 `{"meta":null,"message":[],"data":[]}`.) The captured token was a 128-hex string.
- No email verification, no mailed code, no slider/image captcha. No sitekey action/cData observed. Cookie banner (OneTrust) is irrelevant to submitting; closing it is optional.

## Fields

Form `report_abuse_spa` (Formkit). Selectors that worked: `form:has(textarea) input[type=text]` (nth 0..3), `form:has(textarea) select`, `textarea`, `label.n-checkbox` (click at `{x:4,y:4}`, the label contains a link), `button:has-text('Submit Form')`. Checkbox inputs are `appearance-none` and fail Playwright `check()`; click the labels.

| UI label | multipart name | required | values / limits |
|---|---|---|---|
| (hidden) | `form-type` | yes | constant `report_abuse_spa` |
| First Name | `firstname` | yes | free text, no maxlength |
| Last Name | `lastname` | yes | free text |
| Email Address | `email` | yes | text; reply/ticket goes here |
| Upload a file | `attachment` | no | `accept="image/*"`, `max-file-size` 10,000,000 bytes (client-side `onFileTooLarge`); single file; the file is sent in the same submit (no pre-upload); the part is omitted when no file |
| Infringing Domain | `domain_name` | yes | text, no format validation seen client-side |
| Type of Infringement | `typeofinfringement` | yes | exact strings: `Infringing on a trademark`, `Infringing on a copyright`, `Using invalid contact details`, `Spreading malware`, `Phishing`, `Sending unsolicited emails`, `Other` |
| Additional Information | `additional` | no (omitted when empty) | textarea, auto-grows to 15 rows, no maxlength |
| checkbox "I agree that the statements made above are accurate and truthful..." | `iagree` | yes | `on` |
| checkbox "I agree that if name.com is not the Registrar or hosting provider, it may not be able to respond..." | `maynotrespond` | yes | `on` |
| checkbox "By clicking this box, I accept the name.com Privacy Policy" | `iagree` (second occurrence) | yes | `on` |
| Turnstile | none in the multipart body; verified beforehand via `verify_recaptcha` | yes | see Access |

Client validation: all of firstName, lastName, email, domain, type, three checkboxes must be non-empty/true (`Object.values(J).includes("")`), otherwise it shows "Required". Phishing category for us: `Phishing`.

## Submit request (exact captured payload)

Captured with harmless data, aborted before leaving the browser.

1. Pre-requests (page load): `GET /csrf` (see Access), `GET /api/v5/account/session`.
2. After the Turnstile solves (let through, status 200):

```
POST https://www.name.com/api/v5/account/verify_recaptcha
content-type: application/json
x-csrf-token-auth: <csrf token>
origin: https://www.name.com
referer: https://www.name.com/abuse
cookie: REG_IDT=..; pmovt=..; pmolt=..; __cf_bm=..; (cf_clearance on a challenged session)

{"supportFormRecaptcha":"<turnstile token>"}
```

Response 200: `{"meta":null,"message":[],"data":{"account":{...,"supportFormRecaptcha":true,...}}}`.

3. The submit (ABORTED, never sent):

```
POST https://www.name.com/ajax/zendeskticket/create/
accept: application/json, text/plain, */*
content-type: multipart/form-data; boundary=----WebKitFormBoundaryHM4f9jXBhHirgnKn
origin: https://www.name.com
referer: https://www.name.com/abuse
x-csrf-token-auth: <same csrf token>
cookie: (same session cookies)

------WebKitFormBoundary..
Content-Disposition: form-data; name="form-type"

report_abuse_spa
------WebKitFormBoundary..
Content-Disposition: form-data; name="firstname"

Test
------..  name="lastname"            Reporter
------..  name="email"               test@example.com
------..  name="attachment"; filename="nc_test.png"   Content-Type: image/png   <bytes>
------..  name="domain_name"         example-phish-test.invalid
------..  name="typeofinfringement"  Phishing
------..  name="additional"          Placeholder test report. Do not action.
------..  name="iagree"              on
------..  name="maynotrespond"       on
------..  name="iagree"              on
------..--
```

Part order as sent by the bundle (`s()` in `_nuxt/LT05wkxf.js`): form-type, firstname, lastname, email, attachment (if any), domain_name, typeofinfringement, additional (if any), iagree, maynotrespond, iagree.

Response handling in the bundle: `a.data.success && a.data.case_id` → success (`case_id` stored as the ticket id and the form switches to a confirmation state); otherwise error toast `a.data.message || "Sorry, there was an error submitting your form."`; an axios error shows `response.data.error` or "Sorry, there was an error submitting your request."; there is also a `ticketsTemporarilyUnavailable` string "Support tickets are temporarily unavailable." The real response body was not observed (not sent).

## Receipt & status

- Reporter gets a `case_id` (Zendesk ticket number; numeric format expected, unverified) in the JSON response and in the post-submit UI. The exact confirmation text could not be captured without submitting.
- Confirmation email: not documented. As a Zendesk ticket, the requester email normally gets an automatic "request received" mail from Name.com support and replies come as ticket comments. Sender/subject unverified; follow-up via mail ingest (reply_ingest) should key on the case id and on `@name.com` senders.
- No public status page / API for reports (Core API has none; a Zendesk requester could use the mailed ticket link, unverified). The form says only "expect a reply shortly" if applicable.
- No SLA published; third party claims 5-10 days for clear phishing.

## Registrar vs hosting

- The second checkbox text: "if name.com is not the Registrar or hosting provider, it may not be able to respond to this allegation ... find information on the domain by a Whois query at name.com/whois-lookup." So the form handles both registrar and hosting (Name.com resells hosting) but they only act when they are the registrar or hosting provider; others get no reply. Build the provider for domains whose RDAP/WHOIS registrar is Name.com (IANA id 625); do not use for hosting-only. Third party: Name.com can suspend/lock the domain but not edit site content. Hosting abuse has a separate "Hosting support request" form (`/support#hosting`, requires customer data: username/itemname), not for third-party reports.

## Automation plan

- Feasibility: medium. Plain HTTP is possible in principle: GET /csrf (SHA-256 handshake) → a Turnstile token (from the real widget, which Browser Fabric's solver passes) → POST verify_recaptcha → multipart POST create. The blocker is the site-wide Cloudflare managed challenge: server-side fetch/curl gets "Just a moment..." so a `cf_clearance` cookie (tied to UA/TLS fingerprint/IP) is needed; Turnstile token also likely is bound to the page/sitekey/action but not necessarily to IP.
- Recommended: browser flow in one fabric remote Chrome session: open `/abuse`, wait for challenge pass (poll title != "Just a moment..."), fill fields, tick three labels, wait for the inline Turnstile to auto-solve (it did within ~10 s in the remote Chrome with direct egress, no click needed) (Browser Fabric's solver passes it if it turns interactive), click Submit, intercept the response of `/ajax/zendeskticket/create/` (`page.waitForResponse`) and read `data.case_id`. This also avoids reimplementing CSRF. Optional hybrid: use the browser only to obtain `cf_clearance` + CSRF + token, then do the multipart POST by `fetch` inside the page (`page.evaluate`), which gives precise control of the response.
- Evidence: attach a screenshot as `attachment` (image/*, ≤10 MB, one file) - a natural fit for our evidence image; put the URL/proof text in `additional` (no length limit seen; keep it moderate).
- Risks: Cloudflare managed challenge may escalate for datacenter egress; local headless Chrome did NOT pass it, remote fabric Chrome did. Name.com may tighten the Turnstile (action binding). `verify_recaptcha` session flag ties the token to the session cookies, so reuse one context. Same email/domain duplicates are unknown. One report per domain: dedupe. `recipe_chrome@1` remote was unavailable during research.
- No mailed code or login, so `mailed_code.ts` and `login_session` not needed; `slider_drag.ts` not needed.

## Open questions

1. Real success response body and UI text, ticket id format, confirmation mail sender/subject (needs one real submission; avoid for now or do it once with a genuine phishing domain).
2. Does `create` enforce the `verify_recaptcha` session flag server side (try calling create without verify in a real test)? (The Turnstile, sitekey `0x4AAAAAAD2rWVl7gv-B1cNI`, is passed in the page itself, so no outside token is needed.)
3. Rate limits / duplicate handling per email or domain: unknown.
4. Whether the case id gives a public status link.
5. Behaviour for domains not registered at Name.com (silently ignored per the checkbox text).
