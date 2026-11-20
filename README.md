# [Phishing Support](https://phishing.support/)

Phishing Support is an open-source tool to help automate the analysis, reporting, and tracking of phishing emails and malicious websites. It extracts indicators (links, domains, sender headers), performs quick automated checks, and helps to takedown by reporting it to the appropriate providers.

## Goal

- Make it easy to inspect suspicious emails and websites.
- Automate repetitive abuse-reporting tasks.
- Provide a privacy-conscious, auditable record of reports and analysis.

## Features

- Parse and analyze `.eml` email files and extract useful metadata and links.
- Quick automated classification (e.g., likely phishing / probably safe).
- Helpers to report phishing websites to hosting providers, registrars, and takedown services.
- Web UI for submitting emails and URLs, and for reviewing saved reports.

## Quick demo

1. Forward a phishing email to `report@phishing.support` or upload an `.eml` file via the [web UI](https://phishing.support/).
2. Paste a suspicious website URL into the Website field and click Report.
3. The app extracts indicators, performs automated checks, and attempts to report the issue.

## Browser Fabric

Browser operations are mandatory Browser Fabric workloads. Phishing Support does
not install, start, expose, or remotely debug Chromium. Fabric owns the browser
process, browser profile, egress policy, Turnstile guardian, and the ephemeral
CDP capability; the application retains only the report workflow and evidence
logic.

Browser Fabric runs one private `fabric-cdp-relay` for the Phishing Support
trust boundary. It is an internal transport bridge for Rebrowser Puppeteer,
Patchright and the browser task agent. The relay owns the per-principal Basic
credential for both the narrow browser-session lifecycle API and WebSocket
upgrade, so the application receives no Fabric credential. Every CDP client
receives only an opaque route such as
`ws://fabric-cdp-relay:8085/v1/cdp/browser-session_<id>`; the relay looks up
the short-lived Fabric capability through the authenticated Fabric edge and never exposes it, a raw browser
port, VNC, or a caller-selected upstream.

Every session uses Fabric's one browser runtime, `chrome`, and asks for the
headful recipe `recipe_chrome@1` (Chrome on a private X display): phishing kits
and provider forms cloak headless browsers. That recipe uses Fabric's
`default` profile family and its `challenge_captcha-solver@1` challenge set
(the Turnstile/DataDome guardian, plus reCAPTCHA v2 solving only when Death by
Captcha or Anti-Captcha credentials are configured in Fabric). Fabric selects
the challenge set through the recipe, not per session: another set (for example
`challenge_manual-handoff@1`) needs a deployment-catalog recipe that names it,
set as `FABRIC_RECIPE_REF`.

Only `FABRIC_API_URL` and `FABRIC_PROJECT` are required; every reference
defaults to a Fabric built-in and is validated at startup (versioned refs must
name their version, `name@1`):

```text
FABRIC_API_URL=http://fabric-cdp-relay:8085/v1
FABRIC_PROJECT=project_...
FABRIC_BROWSER_RUNTIME=chrome
FABRIC_PROFILE_REF=profile_default
FABRIC_RECIPE_REF=recipe_chrome@1
FABRIC_ARTIFACT_POLICY_REF=artifact-policy_standard-30-days@1
FABRIC_TTL_SECONDS=900
```

Egress is split per browser session. Sessions that open attacker-controlled
phishing pages (the default) use `FABRIC_PHISHING_EGRESS_POLICY_REF`, default
`egress_tor@1` (Tor). Sessions that talk to abuse portals and provider
dashboards (provider-form tasks, Cloudflare reporting) use
`FABRIC_REPORTING_EGRESS_POLICY_REF`, default `egress_direct@1`. A page that
cloaks Tor and datacenter visitors is captured again through
`FABRIC_RESIDENTIAL_EGRESS_POLICY_REF`, default `egress_residential@1`.

Fabric has no residential built-in: the residential exit is a policy of the
Fabric deployment catalog (`FABRIC_CATALOG_FILE`, see Fabric's
`docs/catalog.md`) plus an egress-sidecar entry whose listener forwards to the
operator's exit (for example a Tailscale exit node behind an HTTP proxy):

```json
{
  "version": 1,
  "egressPolicies": [
    {
      "name": "residential",
      "routes": {
        "document": { "kind": "proxy", "proxyRef": "residential", "protocol": "http" },
        "api": { "kind": "proxy", "proxyRef": "residential", "protocol": "http" },
        "websocket": { "kind": "proxy", "proxyRef": "residential", "protocol": "http" },
        "static_asset": { "kind": "proxy", "proxyRef": "residential", "protocol": "http" },
        "browser_download": { "kind": "proxy", "proxyRef": "residential", "protocol": "http" }
      }
    }
  ]
}
```

with the sidecar entry `{ "ref": "egress_residential@1", "defaultListenerId": "residential" }`
and a `residential` listener whose upstream secret names that exit.

### Browser task agent

Site visits and provider abuse forms are driven by the browser task agent
(`@browser-fabric/task-agent`, installed from the `browser-fabric` git
dependency): an LLM that works a Chrome tab over raw CDP until its goal is
done and finishes with a result checked against a JSON schema. It runs inside
this application; a site visit attaches it to the capture's own Fabric browser
and tab (the capture's second relay connection), and a provider form leases its
own disposable browser on the reporting egress, released when the task ends and
cancelled when it is interrupted.

The model is the app's own: `OPENAI_MODEL` with `OPENAI_API_KEY` and
`OPENAI_API_BASE_URL` (an OpenAI-compatible endpoint such as OpenRouter, where
the model id may itself contain a slash: `anthropic/claude-sonnet-4.5`). A
provider-form task takes at most 40 model turns, a site visit 60. The credential-shaped synthetic
values of a visit (password, card number, one-time code) are passed as
`{{secret:NAME}}` placeholders: they reach the page and the network recording
but never the model, its step log, or the stored record. File uploads are
disabled: the agent's upload action names files on the machine running it, which
a remote Fabric browser cannot read, and no flow uploads evidence.

A provider-form task is durable at one boundary: its run moves to
`task_started`, with the Fabric session ID, before the agent touches the
provider's page. A finished task settles the route: a `done` result whose
submission contract (`src/lib/abuse/portal/output_validation.ts`) passes is
`submitted`; a result that fails the contract, or an agent asking for something
it does not have (a login, a verification code) is `needs_human`; anything else
is `failed`. A run found in `task_started` after a restart or a fenced job is
`unknown_external_state` and its browser is cancelled, because the form may
have been submitted.

Do not add the Fabric principal password, `BROWSER_REMOTE_DEBUGGING_URL`, Chrome/Xvfb,
VNC/noVNC, a local profile volume, or a capability-bearing CDP URL back to this
deployment. No captcha is solved in this app: Browser Fabric runs a solver
(llm-captcha) in every browser it hands out, which passes Turnstile,
reCAPTCHA v2, hCaptcha, Tencent's and Aliyun's sliders, GNAME's slider and
kits' drag or hold checks, and publishes its progress on the top document as
`<html data-captcha-state="solving|solved|failed" data-captcha-detail="…">`.
`src/lib/browser/captcha_state.ts` waits on that state. Providers that file
over HTTP behind a reCAPTCHA or Turnstile (Tucows, NameSilo) take the token
from their form page in a Fabric browser before the durable marker
(`providers/kit/captcha.ts`); Tencent, Newfold, GNAME, Google Cloud and the
Alibaba Cloud login wait for the solver in the page that files or logs in.

## Cloudflare abuse reports

Cloudflare phishing reports use the authenticated dashboard API at
`https://dash.cloudflare.com/api/v4/accounts/{account_id}/abuse-reports/abuse_phishing`.
Patchright logs in through Fabric's reporting (direct) egress before the durable
submission marker. The dashboard's `x-atok` and `vses2` credentials are cached in
the application database, never in report payloads or audit events. Configure:

```text
ABUSE_CLOUDFLARE_ACCOUNT_ID=<32-character account id>
ABUSE_CLOUDFLARE_LOGIN_EMAIL=<dashboard login email>
ABUSE_CLOUDFLARE_LOGIN_PASSWORD=<dashboard login password>
URLSCAN_API_KEY=<urlscan.io API key>
```

Login is single-flight through `abuse_locks`. A report POST is never replayed on
network errors, 5xx, or missing confirmation. Only an explicit HTTP 403/code 9300
session rejection permits one refreshed login and one new POST; a failed login
or rejected fresh session requires human intervention. Success requires both
`result: "success"` and an `abuse_rand` receipt. The public bearer-token API is
not used because this account lacks its abuse-reports entitlement.

Every confirmed site is linked into its campaign (`link_campaign`) by what
only its operator has: exfiltration backends, payment receivers, and the kit's
own code (scripts and hidden-frame documents the live capture received, at
least 1 KiB, not a CDN or published library file). A site captured before
captures recorded those files gets them from a urlscan.io scan of the site
whose page text matches our analyzed page (a down, parked or replaced site's
later scans do not); Cloudflare's `/cdn-cgi/` files never count. Each campaign
is then searched on urlscan.io for further copies of that code
(`search_campaign_kits`, in a worker lane of its own): daily while it finds new
sites, weekly after 14 quiet days, and no longer after 60; a site linked into a
campaign whose search ended starts it again. Only code an original report's
site holds, or two confirmed sites share, is searched, and the search skips a
hash urlscan shows on more domains than one kit plausibly runs on (a shared
library). urlscan's quota running out puts a backfill or search off until it
resets; it never ends one. Each new domain opens as a normal website submission, and the
ordinary capture and classifier still decide whether it is reportable. Every
confirmed site is linked again once when `CAMPAIGN_RULES_VERSION`
(`src/lib/campaign/sweep.ts`) is raised, and on `POST
/api/operator/campaigns/rebuild`. `URLSCAN_API_KEY` enables the authenticated
quota (1,000 searches a day); without it the same bounded searches use
urlscan.io's anonymous quota.

When Cloudflare explicitly names a hosting-provider abuse mailbox in a reply,
the worker additionally validates matching ASNs through RIPEstat, performs a
bounded sweep of public IPv4 addresses, and reports only servers that both
present the phishing domain's certificate and return an exact captured kit-file
hash through the normal durable email route. Sibling domains found by the
all-case search are included in that host report only after the swept origin
also presents their certificate.

Account logins of providers (Cloudflare's dashboard, Alibaba Cloud's Reporting
Center) share one session machine (`src/lib/abuse/providers/login_session`):
sessions are stored in `provider_login_sessions`, one login runs at a time
across processes, and a failed login is not retried for a while so the account
is never locked out.

## Alibaba Cloud abuse reports

Alibaba Cloud's abuse mailboxes (`domainabuse@service.aliyun.com`,
`infosec@service.aliyun.com`, and `abuse@alibaba-inc.com` from its IP space's
RDAP records) are its fallback for reporters who cannot log in. Routes to them
file the report in the Reporting Center (`report.alibabacloud.com`, "Illegal
Information Reporting") instead of mailing it. Every form there needs a logged-in
Alibaba Cloud account, so:

- Patchright logs in through Fabric's reporting egress. From a browser Alibaba
  does not know, it mails a code to the account address, which is the service
  mailbox; the login reads it over IMAP (`IMAP_*` must be configured).
- The console's cookie jar and CSRF token (`SEC_TOKEN`) are stored as a login
  session. Alibaba issues them as browser-session cookies, so a persistent
  browser profile would lose them on every browser restart; the stored jar is
  reused until the console answers `ConsoleNeedLogin`, which logs in once more.
- The report itself is plain HTTP against the console API (`/data/api.json`,
  product `abusereport`): the screenshot goes to Alibaba's OSS through
  `UploadFileByName` before the durable submission marker, then
  `GetCrossRegionExist` and `SubmitReportTask`. The task ID from
  `ReportTaskList` is the receipt, and `GetReportStatus` is polled as the
  report's correspondence.

```text
ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL=<Alibaba Cloud international account email>
ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD=<its password>
```

## AWS abuse reports

AWS answers mail to `trustandsafety@support.aws.com` (and `abuse@amazonaws.com`)
with a pointer to its web form, so routes to them file the report through the
form's API instead: one unauthenticated JSON `POST` to
`api.support.aws.amazon.com/v1/contacts/report-abuse-v2` (no login, cookies or
captcha; the signed-in console form sends the same request).

- One `web_content_events` entry per observed URL (at most 10, each at most 1024
  characters), timestamped at filing time to the minute; `phishing` or
  `malware-website` as the abuse type. The form takes no files, so the comments
  link the case page with the screenshots, and never contain `<` or `>`.
- The reporter is the service identity. The `tracking_id` is
  `PS-<case tag>-R<route id>`, also the run's receipt: AWS's case mail
  ("Your AWS Abuse Report [P01M7…]", from `trustandsafety@support.aws.com`)
  quotes the comments, so it names the route. That mail is a human reply that
  can ask for more information, and goes through the regular reply classifier.
- A 400, 413 or 422 means nothing was filed; any other failure after the
  durable marker is ambiguous and is never retried. AWS has no API to look a
  report up, so status arrives only by that mail.

## Registrar and host abuse forms

These providers answer mail to their abuse mailbox with "not monitored, use our
form" (seen in replies from 2026-10/11), so routes to those mailboxes, and
for registrars to their IANA registrar ID, file through the form instead. Each
is a pinned provider under `src/lib/abuse/providers/<name>/`; research with the
captured requests is in `docs/providers/`.

| Provider | Mailboxes / registrar IDs | Channel |
| --- | --- | --- |
| Tucows / Enom (`tucows`) | domainabuse@tucows.com, abuse@enom.com; 48, 69 | bullwark.tucows.com: Turnstile (Fabric browser preflight), mailed code, multipart form, plain HTTP |
| PublicDomainRegistry (`publicdomainregistry`) | abuse-contact@, abuse@publicdomainregistry.com; 303 | WordPress form behind Cloudflare + Turnstile, in a Fabric browser |
| Microsoft (`microsoft`) | abuse@microsoft.com, cert@microsoft.com | unauthenticated JSON API `api.msrc.microsoft.com/report/v3.0/abuse` |
| GoDaddy (`godaddy`) | abuse@godaddy.com; 146 | Abuse API (`GODADDY_ABUSE_API_KEY`/`_SECRET`) once GoDaddy enables the key, otherwise the Legal Portal form (reCAPTCHA v3 in the page) |
| Newfold: Bluehost, Web.com, Network Solutions, Register.com, Domain.com (`newfold`) | abuse@bluehost.com, abuse@unifiedlayer.com, iarpoc@newfold.com, net-eng-team@newfold.com, domain.operations@web.com; 2, 9, 886 | newfold.com/abuse behind Cloudflare, reCAPTCHA v2 passed by Fabric's solver in the filing page |
| Dynadot (`dynadot`) | abuse@dynadot.com; 472 | form behind Cloudflare + Turnstile, in a Fabric browser |
| Name.com (`name_com`) | abuse@name.com; 625 | Zendesk form behind Cloudflare + Turnstile and a CSRF handshake, in a Fabric browser |

- Browser forms share `providers/kit/browser_form.ts`: a Fabric session on the
  reporting egress that passes the Cloudflare challenge, waits for the
  Turnstile or reCAPTCHA token the browser's solver passed, and
  sends the filing request from inside the page so its clearance applies.
  Everything before the one filing request files nothing and is retried safely.
- Every report's free text starts with `Reference: PS-<case tag>-R<route id>`
  (`providers/report_reference.ts`); it is the receipt unless the provider
  returns its own case ID, so provider mail quoting it reaches its route as a
  reply for the regular classifier.
- A spam or captcha verdict from a form files nothing and settles the route as
  `needs_human` rather than refused. Namecheap's Phishing Reports API and
  GoDaddy's Abuse API were requested by mail on 2026-11-20 (GoDaddy account
  757262365, credentials in the deployment environment).

## Reporting pipeline

Every report goes through one durable reporting worker:

- A **website** confirmed as phishing becomes a report targeting the captured host, with the URL and archive screenshot as evidence.
- A reported website is **visited** the way its victim would go through it: the browser task agent enters only unique synthetic values (at most ten form submissions) while an application-owned CDP recorder captures requests and downloads over the same Tor-egress Fabric session. An endpoint becomes reportable only when it actually receives a probe value; unrelated third parties and same-site requests are excluded. Telegram bots and Discord webhooks are modeled as service accounts rather than falsely reporting the shared service's registrar or hosting network. Telegram receives an abuse email after a read-only `getMe` identity lookup; Discord evidence is retained as `needs_human` because its supported report flows do not accept webhooks. Attacker-owned collector domains use the normal registrar/hosting resolver.
- An **email** confirmed as phishing becomes a report with two targets: the message itself (filed with Netcraft's mail API) and the public IP of the first external `Received` hop, whose RDAP/WHOIS abuse contact receives the recipient-redacted `.eml`. Every linked page is analyzed as its own website submission.
- The **public form** at `/abuse-reporting` reports domains or IPs directly and asks for the reporter's name and email. The `POST /api/abuse/reports` API it uses accepts `reporterName` and `reporterContactEmail` as optional fields; an integration that sends neither files the report as Phishing Support alone.

The resolver turns each target into provider routes (registrar/hosting abuse mailboxes, Cloudflare, Alibaba Cloud, AWS, NameSilo, Tencent, Google Safe Browsing, Netcraft). Each route is submitted, retried, or settled independently; the submission page's Reports tab shows every route with its sent report and provider replies. A report counts as submitted when at least one provider confirmed it, so one unreachable provider never hides the others.

Capture sessions explicitly request two external CDP connections: the capture's own client and the visiting agent. Every other Fabric session remains single-client. Network captures are capped at 2,000 requests, 256 KiB per value, and 10 MiB total.

Providers always see the service identity defined in `src/lib/network/service_identity.ts` (Phishing Support, `support@phishing.support`, `https://phishing.support`); it is code, not configuration, because routes pin the provider definitions that embed it. When a public report names its submitter, the name and/or email appear only in the report text as the original reporter, and Cloudflare additionally receives the submitter's country when known.

## Campaigns and criminal referrals

Takedown alone does not stop an operator, and a single phishing site with an unknown operator is closed by any prosecutor. Authorities act on a case that ties many sites to one operator, so every confirmed website is grouped into a **campaign** by what only one operator has: the Telegram bot, Discord webhook or collector host its visit sent the synthetic values to, an IBAN or crypto address the page names (checksums verified), or a script/hidden-frame file of the kit itself. A kit file counts only when it is at least 1 KiB, not served from a top-ranked site, and not a published library file (checked by SHA-256 against jsDelivr). The server IP is recorded but never links sites. Grouping runs after every report resolution; `/operator/campaigns` can rebuild all campaigns.

Every campaign has a public page, `/campaigns/<id>`, that the submission list links as one tile per campaign. It is built from stored data for every campaign alike:

- a title and summary the model writes from the sites' analyses (with a fixed-wording fallback), rewritten when sites join;
- each page with a preview cut to what the page drew, its language and its takedown history;
- why the pages are one operator's, from the indicators that hold;
- the technical record: where entered data went, bot tokens and accounts exactly as the kit published them, kit files, DNS, every report with its ticket, and every evidence file with its SHA-256;
- `/campaigns/<id>/evidence.zip`, the whole dossier with its files.

**Visit evidence.** When the visiting agent walks a site with synthetic values, the case keeps a timestamped record for use in court:

- `visit-record.json`: the synthetic values, each agent action with what it typed into which element and when, the pages shown, and every request the browser sent, with its body, the page that sent it, its headers and the server's answer;
- `visit-protocol.txt`: the same as a dated chronology;
- `visit-manifest.json`: both files by SHA-256;
- `visit-manifest.tsr`: an RFC 3161 token over the manifest.

Nothing is injected into the page; only CDP's Network domain is used, because enabling Runtime is what anti-bot kits detect.

A campaign's operator page (`/operator/campaigns/<id>`, behind HTTP Basic auth with `OPERATOR_PASSWORD`) drafts, for one authority at a time:

- a **criminal complaint against persons unknown**, with every site, its takedown reports, the linking indicators, how an investigator reaches each provider's records, a link to the public evidence archive, and `Websites.csv`/`Merkmale.csv` attached;
- a **supplement** with only the sites the authority has not received, under its file number;
- once a file number exists, a **preservation notice** to each provider mailbox the sites were reported to.

Nothing is sent without the operator approving that mail; an approved mail is sent exactly as approved, through the normal durable email route, and replies are correlated to it. A reply that names exactly one file number (Aktenzeichen, Tagebuch- or Vorgangsnummer) sets it; otherwise the operator chooses or types it (letters by post). Every takedown report asks the provider to suspend rather than delete and keep account, payment and access-log data for 90 days. Research and design: `docs/research/criminal-referral-routes.md`, `docs/design/criminal-referral.md`.

```text
OPERATOR_PASSWORD=<at least 16 characters>
REFERRAL_COMPLAINANT_NAME=<full name of the complainant>
REFERRAL_COMPLAINANT_ADDRESS=<street; postcode city>
REFERRAL_COMPLAINANT_PHONE=<optional>
```

## Mail configuration

Reports leave through our own relay, Postfix with DKIM on respond5 ([docker/mailer](docker/mailer/docker-compose.yml)); one mailbox receives everything:

```text
SMTP_HOST=phishing-mailer SMTP_PORT=587 SMTP_SECURE=false  # the relay on dokploy-network
SMTP_USER=reports@phishing.support SMTP_PASS=<MAILER_SASL_USERS password>
SMTP_FROM=support@phishing.support      # visible sender of every report
SMTP_RETURN_PATH=bounces@mail.phishing.support  # envelope sender: the relay files bounces itself
RELAY_BOUNCE_MAILDIR=/app/data/relay-bounces    # where the relay files them, read by the app
IMAP_HOST, IMAP_PORT, IMAP_SECURE, IMAP_USER, IMAP_PASS
IMAP_MAILBOXES=phishing.report,phishing.support  # every folder that receives intake mail or provider replies
IMAP_LISTEN_ADDRESS=report@phishing.support
REPLY_DOMAIN=phishing.support           # must equal the IMAP_LISTEN_ADDRESS domain
```

Each abuse email uses `SMTP_FROM` as its visible sender and a new opaque `Reply-To` such as `abuse-<48 hex>@phishing.support`, unique to one route. Bounces go to the envelope sender `SMTP_RETURN_PATH`, which the relay keeps: it files them into `RELAY_BOUNCE_MAILDIR` on the shared data volume, and the app ingests them like IMAP mail (`src/lib/imap/maildir.ts`). They cannot go to the iCloud mailbox, which refuses every bounce notice from our relay (`554 5.7.1 [HM08]`). A server that refuses the attached phishing mail rather than the mailbox gets the report once more with the mail attached as text; servers known to do so get text from the start (`src/lib/abuse/mail/attachment_policy.ts`). iCloud's own SMTP refused reports carrying live phishing URLs (`550 5.7.1 [CS101]`), which is why reports do not go out through the mailbox provider. A refusal by the relay itself is detected (`src/lib/abuse/mail/relay_refusal.ts`) and retried once per relay: changing `SMTP_HOST` resends every report the old relay refused last. `REPLY_DOMAIN` must deliver into one of `IMAP_MAILBOXES` (for iCloud Custom Email Domain, enable **Allow All Incoming Emails**; see Apple's [catch-all guide](https://support.apple.com/guide/icloud/allow-all-incoming-emails-mm9e3ee0680f/icloud)). Do not substitute plus-addressing.

Every abuse email subject carries a case tag such as `[PS-50a7a280104d]`, because most helpdesks answer from their own address without `In-Reply-To`. The mailbox listener watches every folder and routes each message exactly once, strongest evidence first:

1. A message addressed to one of our generated `Reply-To` identities, or whose `In-Reply-To`/`References` names one of our outbound `Message-ID`s, is stored on that route.
2. A delivery-status notification is stored on the route whose outbound `Message-ID` it returned. A permanent rejection marks the email undeliverable; a temporary one resends it with the same identity.
3. An authenticated notification from a direct provider (Netcraft) is stored on the route whose receipt ID it names. Cloudflare's correspondence is read from its submitted-report API instead (hourly for 30 days after submission), so its emails are not attached twice.
4. A reply whose sender iCloud authenticated (DMARC, or an aligned DKIM/SPF pass) and which we emailed is stored on that sender's route when it names the case tag or case URL, or else repeats our exact subject.
5. Otherwise, mail to `IMAP_LISTEN_ADDRESS` becomes an email submission (already-read intake mail is skipped).
6. Everything else is recorded as ignored in the `mail_ingest` ledger and left in the mailbox.

A message that fits more than one route attaches to none. An unauthenticated sender never selects a report.

### Provider-facing reports

Provider-facing reports are not copies of the AI analysis shown in the
submission's Analysis tab. The detailed analysis is retained as audit evidence,
while every direct provider adapter builds its own bounded report from the
normalized target, observed URL(s), allegation category, and detected evidence
indicators. Cloudflare receives a hosted-content/abuse-policy narrative, Google
Safe Browsing receives a URL-focused explanation, Netcraft receives a concise
infrastructure-investigation reason, and Tencent receives a domain-abuse
narrative that fits its short form field. A provider-specific draft is pinned
before its external request and is what the provider receives.

The submission detail page distinguishes a verified/queued route, local draft
preparation, an in-flight provider request, a provider-confirmed submission,
and an ambiguous external outcome. “Provider receipt has not been confirmed
yet” means the last of those lifecycle boundaries has not produced a verified
provider response; it is not by itself a delivery failure. A slow provider
preflight (for example, CAPTCHA solving) runs in its own worker slot and does
not hold unrelated provider routes behind it.

### Provider-facing email drafts

An abuse-mailbox route does **not** send the stored AI analysis as the
message body. Before SMTP, the abuse worker creates a separate provider-facing
draft for each resolved recipient. The draft has a recipient-specific greeting
(for example, the Hostinger organization from RDAP), the exact normalized target
and observed URLs, a bounded evidence summary, the available evidence filenames,
and an explicit request to investigate and mitigate. When configured, a separate
OpenAI Responses call writes only the short evidence summary; the surrounding
email remains a code-owned template. If the model is unavailable, the worker
sends a factual deterministic summary rather than failing or copying the
analysis. Model output is schema-validated, bounded, checked for long verbatim
passages and unapproved URLs, and treated as untrusted data.

The first draft is persisted in the provider run before SMTP and is reused
unchanged only for a retry that is durably known to have failed before provider
acceptance. A draft that is not a verified, persisted report is stopped rather than resent. Drafting and reply
classification use the analysis endpoint (`OPENAI_API_KEY`,
`OPENAI_API_BASE_URL`, `OPENAI_MODEL`); each call is bounded to 45 seconds. The deterministic template works
without an AI configuration.

## Analysis stream recovery

Model analysis requests are streamed through `OPENAI_API_BASE_URL`. A provider can
accept the HTTP request with `200 OK` and still send a `server_error`, timeout, or
connection failure later in the SSE stream. The analyzer treats the complete stream
(not just `responses.create`) as the retry boundary: transient failures are retried
with bounded exponential backoff (up to three complete attempts by default), but a
partial model answer is never replayed into the same run. Permanent, authentication,
and schema failures remain failed immediately, with the last error and attempt count
stored in the analysis-run diagnostics.

Set `OPENAI_ANALYSIS_MAX_ATTEMPTS` to tune the complete-attempt limit. The deployed
Open-WebUI adapter routes the `gpt-5.5` alias to its `codex_ws` provider; make sure
the alias is enabled and that at least one account has usable quota before retrying.
Failed email and website analyses that have not crossed the reporting boundary can
also be retried from the submission page. Email retries reuse the retained `.eml` artifact; website
retries reuse a retained MHTML capture when one exists and recapture the URL only
when the original attempt did not produce an archive. Both actions atomically claim
the submission, so concurrent clicks cannot create duplicate analysis/report work.

## Netcraft reporting

Every report target with one or more validated observed URLs gets an independent Netcraft Reporting API v3 URL submission, alongside the resolver-selected routes and Google Safe Browsing. Every confirmed phishing email is filed with Netcraft's `POST /report/mail` endpoint using the recipient-redacted RFC 822 source stored as report evidence. Netcraft rejects a message without a parseable sender, so a message with no `From` address (for example a forwarded bounce) is submitted with an explicit `From: Unknown sender <unknown-sender@invalid>` header. Messages over Netcraft's 20 MiB limit are settled as insufficient evidence and never sent. Each returned submission UUID is kept on the route.

Netcraft's API requires a reporter email. The service sends its own mailbox and never discloses a submitter's address. URL-only providers are never given invented URLs.

## Privacy note

Only submit emails or links that you are allowed to share publicly. The project is intended to help protect users and organizations - do not use it to probe private systems or to impersonate abuse inquiries.

## Contributing

Contributions, bug reports, and improvements are welcome. Please open issues or pull requests on the project's repository. When contributing, keep changes focused and include tests where appropriate.
