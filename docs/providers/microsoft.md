# Microsoft (MSRC Report Abuse) provider research

Researched 2026-11-20. Nothing was submitted: the submit request was captured with `page.route(...).abort()`.
Browser note: `fabric up --remote` failed repeatedly (Cloudflare 502 from the fabric origin, then "no remote browser became ready" = all slots busy, also with `--fresh`), so the exploration ran in one persistent local headless Chrome (`fabric up --headless --profile microsoft --name microsoft`, CDP :9226). Result is not affected: the form is a static SPA calling a plain JSON API.

## Channel

- `abuse@microsoft.com` / `cert@microsoft.com` are unmonitored; the channel is the MSRC Report Abuse portal `https://msrc.microsoft.com/report/abuse` and its API (`https://api.msrc.microsoft.com/report/v3.0/...`). The portal itself is the API's only client: the SPA bundle (`/report/abuse/static/js/ReportAbusePage.*.js`) posts to the same endpoint a script can.
- Docs: `https://msrc.microsoft.com/report/developer` (incident-type table), repo `github.com/microsoft/msrc-microsoft-engage-api` (stale samples still show `/report/v2.0/abuse`; v2.0 now 404s). Current OpenAPI: `https://api.msrc.microsoft.com/report/v3.0/swagger/v2/swagger.json` (public, no auth).
- OpenAPI paths: `POST /Abuse/report` (JSON), `POST /File/abuse/File.Attach` (attachment), `GET /$metadata`. No `security` scheme defined. The SPA calls `POST /report/v3.0/abuse` and `POST /report/v3.0/file`.
- Phishing = `threatType: "URL"`, `incidentType: "Phishing"` ("URL - Phishing Website" on the portal; deep link `https://msrc.microsoft.com/report/abuse?ThreatType=URL&IncidentType=Phishing`). Enums (swagger): incidentType = Brute Force, Denial of Service, Illegal/Violates the rights of others, Malware, Phishing, Spam, Azure Account Compromise, Malicious Artifact, Malicious Text or URL, Responsible AI, Impersonation Email Name/Domain Url/Typo Squatting, M365/W365 Account Compromise, gaming types...; threatType = IP Address, URL, Community Gallery, Azure Subscription, Impersonation, M365 Investigation, W365 Investigation, Gaming; source = `CertPortalV2` | `ReportApi`.
- Scope per page text: "abuse originating from a Microsoft-hosted site or service" (Azure, Bing, OneDrive, Office 365, Microsoft IP space). Azure notice: Microsoft forwards to its customer, may share reporter contact unless `anonymizeReport`.
- Rate limits: none published. Only hint: UI error text for HTTP 429: "You may have tried to submit the same report twice, or too many reports at one time... wait a few minutes". Max 10 URLs (or 10 IPs) per report; MSRC blog (2024/07 "What's new in the MSRC Report Abuse Portal and API") says API has no item-count restriction for some report kinds.

## Access (login/captcha)

- No login needed for the Phishing/URL form: the page shows only a "Sign in" button; I submitted anonymously. Only Azure Subscription / Gaming threat types redirect to sign-in when not internal (bundle: `if(!r&&(C||U)) redirect`).
- No captcha: no reCAPTCHA/hCaptcha/Turnstile script or widget on the form, none in the bundle, none in the captured request (no token field/header). No Authorization header, no cookies required (captured headers below).
- No email verification step in the flow (`/abuse/submitted` immediately after POST).
- `reporterEmail` is not verified; Microsoft may contact the reporter.

## Fields (phishing form, `incidentType=Phishing`, `threatType=URL`)

| Field (JSON) | Label | Req | Rules |
|---|---|---|---|
| `threatType` | hidden | yes | `"URL"` |
| `incidentType` | hidden | yes | `"Phishing"` |
| `source` | hidden | no | `"CertPortalV2"` (portal); API value `"ReportApi"` |
| `reporterName` | Name | yes | text, minLength 1 |
| `reporterEmail` | Email | yes | maxLength 64, `^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$` (i) |
| `reporterOrg` | Organization | no | maxLength 64 |
| `phoneNumber` | Phone number | no | libphonenumber-validated (default US, `+` auto-added); portal strips non `[0-9+]`; `""` accepted |
| `reporterNotes` | Additional information (contact section) | no | max 15000 |
| `anonymizeReport` | Anonymize report | no | boolean |
| `date` | Incident date | yes | `yyyy-MM-dd`, not in the future (maxDate today) |
| `time` | Incident time | yes | `HH:mm` or `HH:mm:ss`, maxLength 8 |
| `timeZone` | Time zone | yes | dropdown of 80 Windows-style labels "(GMT-12:00) International Date Line West" ... "(GMT+12:00) Fiji, Kamchatka, Marshall Is."; submitted value is the offset `"-1200"` (observed for GMT-12; other offsets presumably `±HHMM`, e.g. `"+0100"`, `"+0530"` - verify) |
| `urlList[].sourceUrl` | Source URL | yes (>=1, <=10) | http(s) URL pattern, exactly one URL per item (no `,;|` or whitespace-separated lists) |
| `urlList[].destinationUrl` | Destination URL | no | same pattern |
| `reportNotes` | Report notes | yes | minLength 1, maxLength 2000 |
| `attachmentId`, `attachmentFileName` | file upload ("Choose a file to upload") | no | set after `POST /report/v3.0/file` (see below) |
| `testSubmission`, `severity`, `icmNumber` | internal-only | - | only rendered for internal users |

Unused for phishing: `sourceIp/Port`, `destinationIp/Port`, `ipAddressList`, `attackMethod`, `reportedTenantId`, `reportedSubscriptionId`, `destinationUrl` top-level.

File upload: input `name=fileUpload`, no `accept` attribute. Bundle: `d(fileUpload)` -> `POST /report/v3.0/file` (axios multipart FormData of the FileList, so field likely `files[]`), response is an array: `u[0].id` -> `attachmentId`, `attachmentFileName = file.name`. Type/size limits not found client-side (server-enforced; unverified - not uploaded).

## Submit request (captured, aborted, never sent)

```
POST https://api.msrc.microsoft.com/report/v3.0/abuse
accept: application/json, text/plain, */*
content-type: application/json
origin: https://msrc.microsoft.com
referer: https://msrc.microsoft.com/
request-id: <uuid>        (App Insights correlation, also x-request-id; not required presumably)
user-agent: Mozilla/5.0 ... HeadlessChrome/158 ...
(no authorization, no cookie, no captcha token)
```

```json
{"threatType":"URL","source":"CertPortalV2","incidentType":"Phishing","reporterName":"Test Reporter","reporterEmail":"test@example.com","reporterOrg":"Test Org","phoneNumber":"","reporterNotes":"","time":"12:00","urlList":[{"sourceUrl":"https://example.com/phish"}],"reportNotes":"PLACEHOLDER harmless test, do not action","timeZone":"-1200","date":"2026-11-19","anonymizeReport":false}
```

No pre-submit token or upload call occurred without a file (only telemetry: `dc.services.visualstudio.com`, `browser.events.data.microsoft.com`, `amcdn.msftauth.net/me`, all irrelevant). Error handling in the SPA: string body or `{message}` -> root error; `{errors:{Field:[msg]}}` (ASP.NET validation, field names PascalCase) -> per field; HTTP 429 -> duplicate/too many.

## Receipt & status

- Success: SPA navigates to `/report/abuse/submitted`, title "Report Submitted", text "Thank you for submitting your report!". The page shows no case ID; whether the POST response body carries one is unknown (not observed; swagger declares only `200` with no schema). A real first submit is needed to see it.
- No confirmation mail or status-check endpoint documented for abuse reports. (The authenticated vulnerability-report portal has GraphQL status queries with `ticketNumber`, but that is the separate MSRC vuln flow, not abuse.) Treat as fire-and-forget; store the HTTP status + response body + timestamp as the receipt.

## Automation plan

- Plain HTTP, no browser, no DBC, no mailed code: one `fetch` POST of the JSON above (optional `POST /report/v3.0/file` first for evidence screenshot). Use `source: "ReportApi"` as the documented API source (worth testing that the server accepts it unauthenticated; fall back to `CertPortalV2` which the anonymous portal uses). Send browser-like `origin`/`referer` and a fresh `request-id` uuid.
- Map: reporter name/email from our reporter profile, `date`/`time`/`timeZone` from detection time (UTC => `"+0000"`; confirm accepted), `urlList` = phishing URL(s) (<=10, one URL per item), `reportNotes` <= 2000 chars (truncate evidence summary), `anonymizeReport` decision (default true recommended to avoid sharing reporter contact with the Azure customer).
- Risks: unpublished rate limits/429 on duplicates (dedupe per URL); unauthenticated endpoint may later gain captcha/auth (portal could change; keep a detect-and-fail path); no receipt ID means no later verification; timeZone value format for non-negative offsets unverified; API may silently drop reports for URLs not hosted on Microsoft (see below); file upload constraints unknown.
- Feasibility: easy.

## Registrar vs hosting

Form text and docs scope MSRC abuse to content/attacks "originating from a Microsoft-hosted site or service" (Azure/M365/Bing/OneDrive IP space, e.g. `*.azurewebsites.net`, `*.blob.core.windows.net`, SharePoint, Power Apps portals). Nothing says it handles domain registrar abuse (Microsoft is not a retail registrar; Microsoft-registered domains are brand-protection domains owned by Microsoft). Use it for hosting case when the resolved IP/CNAME belongs to Microsoft (ASN 8075 etc.); not for registrar case. The form does not validate that the URL is Microsoft-hosted (no server rejection observed pre-submit; unknown).

## Open questions

1. Response body of a successful POST (case id?) and whether `ReportApi` source works anonymously - needs one real submission (explicitly not done).
2. `timeZone` value format for other offsets; accepted range.
3. Upload endpoint multipart field name, allowed types, max size.
4. Real rate limit / duplicate detection window.
5. Whether Microsoft sends any confirmation mail to `reporterEmail` (none documented).
6. Whether reports for non-Microsoft-hosted URLs are triaged or discarded.

## Email-origin IP (added 2026-11-20)

- The developer table (`msrc.microsoft.com/report/developer`) lists `Spam` ("any unsolicited emails") for threat type `IP Address` only; `Phishing` is `URL` only. The swagger `AbuseReport` carries `ipAddressList[].sourceIp` (required per item in the portal bundle; ports are required only for Brute Force) and has no email-header field.
- An `ip` target whose report holds the stored `message/rfc822` is therefore filed as `threatType: "IP Address"`, `incidentType: "Spam"`, `ipAddressList: [{ sourceIp }]`, no `urlList`; date/time/timeZone are the Received hop's UTC time (clamped to filing time), the Received line and the mail's links are in `reportNotes`.
- A bare IP (no observed URL, no email) is `insufficient_evidence`: no `https://<ip>/` page is made up.
- Unverified: whether the anonymous API accepts `IP Address`/`Spam` (nothing was submitted), and whether `Spam` reports are triaged for non-Microsoft addresses.
