# GoDaddy abuse reporting (phishing)

Researched 2026-11-20. Nothing was submitted: the one real submit request the browser built was aborted via `page.route`. Caveat: the persistent *remote* Fabric browser could not be started (4 attempts, "origin web server returned an invalid or incomplete response to Cloudflare"), so a local headless Chrome (`fabric up --headless --name godaddy`, patchright over CDP) was used instead and stopped with `fabric down godaddy`.

## Channel

- `abuse@godaddy.com` is not a channel (auto-reply says unmonitored; the help page lists no such address).
- Help page https://www.godaddy.com/help/reporting-abuse-27154: phishing -> web form `https://legalportal.godaddy.com/abuse/phishing` ("site must be live and contain a login area", full URL path). `https://abuseform.com/` just redirects (HTTP 200 after redirect) to `https://legalportal.godaddy.com/abuse`. Categories there: Phishing, Malware, CSAM, IP infringement, UK/EU complaints, Public safety. Mail to `phishing@/malware@/netabuse@/spam@godaddy.com` is "deprioritized".
- Two ways in:
  1. **Public web form (Legal Portal)**: anonymous, reCAPTCHA v3. Backend `POST https://legalportal.godaddy.com/api/v1/submit/abuse`.
  2. **Abuse API** (https://developer.godaddy.com/en/docs/references/rest/abuse; LLM-readable at `https://developer.godaddy.com/llms.mdx/references/rest/abuse`): needs onboarding, see below.
- Old Support Center form https://supportcenter.godaddy.com/abusereport (status at `/abusereport/status?plid=1`, takes a "Claim ID") is a separate legacy system; the Legal Portal case ID does not belong to it.
- Reports about content GoDaddy neither hosts nor registers: GoDaddy says it cannot act (https://www.godaddy.com/help/website-abuse-claims-next-steps-42781).

## Abuse API (official)

- Base `https://api.godaddy.com` (prod), `https://api.ote-godaddy.com` (OTE). Endpoints: `POST /v2/abuse/tickets`, `GET /v2/abuse/tickets` (list), `GET /v2/abuse/tickets/{ticketId}`. v1 (`/v1/abuse/tickets...`) legacy, same records.
- **Auth**: Classic Developer Key only (not PAT): `Authorization: sso-key {KEY}:{SECRET}`. Reporter identity comes from the key (no reporter field).
- **Access gate**: "not open to self-service signup. Access is granted per reporter identity, and requests are rejected with `403` until yours is enabled. Contact abuseapisupport@godaddy.com to start onboarding." The dev portal says "Requires onboarding". No documented reseller requirement, but eligibility is at GoDaddy's discretion. API terms also forbid making keys/API access available to third parties without written authorization (https://www.godaddy.com/legal/agreements/godaddy-api-terms-of-use) and creating keys for other customers. Terms: submit only via API (stop emailing); >40% false positives or >20% duplicates (more than 5 URLs per domain) => deprioritized. Types for every reporter: `PHISHING`, `MALWARE`, `CHILD_ABUSE`.
- **Rate limits**: v2 create+list 60/min, retrieve 60/min; v1 create 750/min.
- **POST /v2/abuse/tickets** JSON body (optional query `skipEmailNotification=true` suppresses the acknowledgement mail to the complainant address):
  - `type` enum `PHISHING|MALWARE|CHILD_ABUSE` (required)
  - `source` string 4..2048, http(s) URL ("http://" prepended if no scheme; IDNA-encoded) (required)
  - `target` string <=2000 (brand), `info` string <=20050, `infoUrl` url
  - `proxy` enum `ARE|SGP|ZAF|USA|BRA|DEU|OTHER|NOT_APPLICABLE` (default `USA`), `useragent` enum `DESKTOP|MOBILE|OTHER|NOT_APPLICABLE`
  - `bundleId` UUID, `complainant` object (details of the person on whose behalf; stored encrypted, not returned)
  - 201 `{"u_number":"DCU12345678"}` + `link: <{url}>; rel="this"`. 401 (may have no body), 403 `{message}`, 422 `{code,message,fields[]}` or `{message}` (open ticket for same `source` exists / invalid TLD / unparseable URL).
- **GET /v2/abuse/tickets/{id}** -> `{ticketId, reporter, source, sourceDomainOrIp, closed, createdAt, closedAt, type, target, proxy, closeReason}`; `closeReason` e.g. `"actioned"` (full enum not documented). Other reporter's id -> 404. No webhook; poll.
- v1 spec (apis.guru mirror) body: `type,source,target,info,infoUrl,intentional,proxy` (free-text proxy).

## Access (login/captcha) - Legal Portal form

- No login/account/email verification required; anonymous. `Your Email Address` is optional.
- Captcha: **reCAPTCHA v3** (invisible badge), sitekey `6Lcds5YsAAAAAOxWlnaB1W5e1KIAmk2AhXuUpe97`, page `https://legalportal.godaddy.com`, action `submit_abuse_report`. Script `https://www.google.com/recaptcha/api.js?render=<sitekey>`; token is sent as `captcha_code`. Server rejects without it: `400 {"error":"Captcha verification is required","success":[],"fail":[]}`. A real headless-Chrome run produced a ~1.9 KB token and the page submitted normally.
- Server also requires header `X-Portal-Request: 1` (status call returns 403 HTML without it; submit without it not tested).
- Cookie banner (`#pw_accept`) overlays the Send button; accept it first when driving the browser.
- Akamai-fronted; submitted `source` with an invalid TLD is untested.

## Fields (https://legalportal.godaddy.com/abuse/phishing)

No file upload exists on this form (attachments: paste headers into Description). No client-side length limits (`maxLength=-1`).

| Label | id / name | Req | Values |
|---|---|---|---|
| Your Email Address | `#email-field` / `contact_email` | no | regex-validated email; "Email Usage Information" tooltip |
| Company or Brand Being Impersonated | `#company-field` / `target` | **yes** | free text |
| URL, Website, or Domain | `#source-field` / `source` | **yes** | textarea, one per line or comma separated -> sent as JSON array |
| Was this viewed from a mobile device? | `#user-agent` / `useragent` | no | checkbox -> `"yes"` or `""` |
| What country did you view this content from? | `#country-field` / `proxy` | no | `N/A` (default) + ~250 English ISO country names ("Germany", "United States of America (the)", ...) |
| Description of Issue | `#info-field` / `info` | no (UI) | textarea |
| Attestation | `#attested` / `confirmed` | **yes** | "I confirm that I am submitting this claim in good faith and that all the information provided is accurate..." |

Send button `#submit-button` ("Send Report", type submit) is enabled once source, target and attestation are filled. Hidden: `type=PHISHING`, `form_plid=1`, `intentional=false`, `contact_name`, `url`, `email_headers`, `electronic_signature` (all empty on the phishing form).

## Submit request (captured with page.route abort; never sent)

```
POST https://legalportal.godaddy.com/api/v1/submit/abuse
content-type: multipart/form-data; boundary=----WebKitFormBoundary...
x-portal-request: 1        (set by page JS, fetch headers {"X-Portal-Request":"1"})
cookie: (Akamai/visitor/consent cookies; no auth cookie)

type=PHISHING
contact_email=research-test@example.com
contact_name=
source=["https://phish-test.example.invalid/login"]     (JSON array string)
url=[]                                                  (JSON array string)
email_headers=
target=ExampleBrand
intentional=false
useragent=yes                                           ("" if unchecked)
proxy=Germany                                           ("N/A" default)
info=Harmless placeholder research text, do not process.
form_plid=1
confirmed=true
electronic_signature=
captcha_code=<reCAPTCHA v3 token, action submit_abuse_report>
```

Source of truth: page chunk `_next/static/chunks/1533-*.js` (FormData built from the zustand form state; mutation `fetch("/api/v1/submit/abuse",{method:"POST",headers:{"X-Portal-Request":"1"},body:formData})`; on `res.ok` JSON it redirects to `/abuse/submission-complete`; non-ok throws `AbuseSubmissionError` with the JSON). The page showed "Cannot read properties of undefined (reading 'fail')" after the abort (client reads `result.fail`), implying the real response JSON contains `success: [...]` and `fail: [...]` arrays (cf. the captcha error shape above). The success body (case ID field name) was not observed.

One accidental unauthenticated probe `POST /api/v1/submit/abuse` with only `type=PHISHING` and no token was rejected with the captcha error above (no report created).

## Receipt & status

- Success page `/abuse/submission-complete` (needs the SPA state; direct visit redirects to `/abuse`). Page copy about the case ID: "Enter the Case ID that was provided in the email you received." -> the case ID is delivered by confirmation mail to `contact_email` (and probably in the success JSON, `case_id`/`response_details` exist in the client store). Sender/subject and ID format are NOT documented and not observed (no real submit); ID format validated server-side (`{"error":"Invalid case ID format"}` for 7/9-digit numbers, `ABC-123`, `CASE-12345`). API ticket IDs look like `DCU12345678` (docs example), likely the same family.
- Status check (public, no captcha, no login): `POST https://legalportal.godaddy.com/api/v1/case-status`, headers `Content-Type: application/json` + `X-Portal-Request: 1`, body `{"caseId":"<id>"}`. 400 `{"error":"Invalid case ID format"}`; 429 `{"error":"Too many requests. Please try again shortly."}` after ~5 requests/min from one IP; unknown-id UI text "Unable to locate this claim". Success JSON has `status`; UI maps `"Closed"` -> "reviewed and resolved. Appropriate action has been taken", anything else -> "under review".
- API route: poll `GET /v2/abuse/tickets/{u_number}` for `closed`/`closeReason`.
- Because the receipt arrives by email, set `contact_email` to a monitored mailbox if we want the case ID (mailed ID could be parsed through `providers/kit/mailed_code.ts`-style inbox reading); with an empty email, case tracking may be impossible.

## Registrar vs hosting

The portal has no registrar/host selector: one report per URL/domain, GoDaddy routes internally ("policies for the brand that hosts or registers the reported content", API docs). Domains registered at GoDaddy but hosted elsewhere are in scope as registrar abuse, but the form needs a live site with a login area. Not verified end-to-end (would require a real submission); GoDaddy itself says it cannot act on sites it neither hosts nor registers. Also separate GoDaddy-registry TLD channel: https://domainabuse.registry.godaddy/s/ (DAR IDs) - not researched.

## Automation plan

Implemented as a Browser Fabric page on the portal (reCAPTCHA v3 has no challenge to solve: its token comes from the page itself):

1. In the real page, `grecaptcha.execute("6Lcds5YsAAAAAOxWlnaB1W5e1KIAmk2AhXuUpe97", { action: "submit_abuse_report" })` (`godaddy/portal.ts` `recaptchaTokenProbe`); the accepted score threshold is unverified.
2. `POST /api/v1/submit/abuse` multipart exactly as above with `X-Portal-Request: 1` and a browser-like UA (Akamai in front). Use the existing proxy support.
3. Parse JSON: success if `ok` and `fail` empty; take the case ID from the body if present, else from the confirmation mail.
4. Status: `/api/v1/case-status` with a throttle (<=3/min), mapping `status === "Closed"` -> actioned.
5. Preferred long-term: apply for an Abuse API key (abuseapisupport@godaddy.com) as a reporter identity of phishing.support; then `POST /v2/abuse/tickets` (JSON, no captcha, `u_number`, `closeReason`) replaces everything above. Provider can support both: API when `GODADDY_ABUSE_API_KEY/SECRET` is configured, portal form otherwise.

Risks: the reCAPTCHA v3 score of a datacenter browser may be too low (no solver can raise it); the response schema and case-ID mail are unverified until the first real submission (do that once with a true phishing URL and record it); one source per ticket and >5 URLs/domain counts as duplicate; Akamai bot rules on datacenter IPs; the portal is a Next.js app and the API is private (can change).

## Open questions

- Success response JSON shape and case-ID format/name; confirmation mail sender, subject, whether it is sent when `contact_email` is empty.
- Which reCAPTCHA v3 score the server requires, and whether the Fabric browser's tokens reach it.
- Whether the server enforces `X-Portal-Request`/Origin on submit, and its rate limit.
- Whether an Abuse API key can be granted to phishing.support (onboarding criteria undocumented; contact abuseapisupport@godaddy.com; expect questions about report quality/volume).
- Behaviour for non-GoDaddy hosted/registered domains (rejection text?).
