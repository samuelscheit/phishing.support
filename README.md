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
trust boundary. It is an internal transport bridge for Puppeteer, Patchright,
and the local dynamic Skyvern companion. The relay owns the per-principal Basic
credential for both the narrow browser-session lifecycle API and WebSocket
upgrade, so the application receives no Fabric credential. The app and Skyvern receive only an opaque route such as
`ws://fabric-cdp-relay:8085/v1/cdp/browser-session_<id>`; the relay looks up
the short-lived Fabric capability through the authenticated Fabric edge and never exposes it, a raw browser
port, VNC, or a caller-selected upstream.

The local `skyvern` service remains only because this service has dynamic,
persisted provider forms, uploads, verification-code workflows, and output
contracts that are not static Fabric manifests. It never owns Chromium,
profiles, egress, or CDP. A dynamic task obtains its browser through the relay;
the opaque Fabric browser-session ID is retained next to the task solely for
heartbeat/release/cancel reconciliation.

The deployment requires all of the following values and secrets:

```text
FABRIC_API_URL=http://fabric-cdp-relay:8085/v1
FABRIC_PROJECT=project_...
FABRIC_PHISHING_PROFILE_REF=profile_...
FABRIC_PHISHING_RECIPE_REF=recipe_rebrowser-phishing@1
FABRIC_PHISHING_ARTIFACT_POLICY_REF=artifact-policy_standard-30-days@1
FABRIC_PHISHING_TTL_SECONDS=900
```

Egress is split per browser session. Sessions that open attacker-controlled
phishing pages (the default) use `FABRIC_PHISHING_EGRESS_POLICY_REF`, default
`egress_tor-egress@1` (Tor). Sessions that talk to abuse portals and provider
dashboards (Skyvern portal tasks, Cloudflare reporting) request the `reporting`
egress and use `FABRIC_REPORTING_EGRESS_POLICY_REF`, default
`egress_direct-egress@1` (direct). Both variables are optional overrides:

```text
FABRIC_PHISHING_EGRESS_POLICY_REF=egress_tor-egress@1
FABRIC_REPORTING_EGRESS_POLICY_REF=egress_direct-egress@1
```

Do not add the Fabric principal password, `BROWSER_REMOTE_DEBUGGING_URL`, Chrome/Xvfb,
VNC/noVNC, a local profile volume, or a capability-bearing CDP URL back to this
deployment. Tencent's direct non-browser provider route may still require its
explicit `PROXY_URL` and `DEATHBYCAPTCHA_*` configuration; those values are not
browser configuration and are never sent to Fabric session metadata.

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

Every confirmed website report hashes same-host scripts, stylesheets, and image
assets from its retained MHTML and searches urlscan.io for exact matches. One
script/stylesheet hash is sufficient; image-only candidates must match at least
two assets. Each candidate opens as a normal website submission, and the
ordinary capture and classifier still decide whether it is reportable. `URLSCAN_API_KEY` enables
authenticated search quota; if absent, the same bounded search uses urlscan.io's
anonymous quota.

When Cloudflare explicitly names a hosting-provider abuse mailbox in a reply,
the worker additionally validates matching ASNs through RIPEstat, performs a
TLS-only sweep of at most 65,536 public IPv4 addresses, and reports every server
that presents the phishing domain's certificate through the normal durable
email route. Sibling domains found by the all-case search are included in that
host report only after the swept origin also presents their certificate.

## Reporting pipeline

Every report goes through one durable reporting worker:

- A **website** confirmed as phishing becomes a report targeting the captured host, with the URL and archive screenshot as evidence.
- A website confirmed as credential theft or payment fraud also queues a controlled **credential-destination probe**. Skyvern fills at most three form stages with unique synthetic values while an application-owned CDP recorder captures requests over the same Tor-egress Fabric session. An endpoint becomes reportable only when it actually receives a probe value; unrelated third parties and same-site requests are excluded. Telegram bots and Discord webhooks are modeled as service accounts rather than falsely reporting the shared service's registrar or hosting network. Telegram receives an abuse email after a read-only `getMe` identity lookup; Discord evidence is retained as `needs_human` because its supported report flows do not accept webhooks. Attacker-owned collector domains use the normal registrar/hosting resolver.
- An **email** confirmed as phishing becomes a report with two targets: the message itself (filed with Netcraft's mail API) and the public IP of the first external `Received` hop, whose RDAP/WHOIS abuse contact receives the recipient-redacted `.eml`. Every linked page is analyzed as its own website submission.
- The **public form** at `/abuse-reporting` reports domains or IPs directly and asks for the reporter's name and email. The `POST /api/abuse/reports` API it uses accepts `reporterName` and `reporterContactEmail` as optional fields; an integration that sends neither files the report as Phishing Support alone.

The resolver turns each target into provider routes (registrar/hosting abuse mailboxes, Cloudflare, Tencent, Google Safe Browsing, Netcraft). Each route is submitted, retried, or settled independently; the submission page's Reports tab shows every route with its sent report and provider replies. A report counts as submitted when at least one provider confirmed it, so one unreachable provider never hides the others.

Probe sessions explicitly request two external CDP connections: one bounded recorder and one Skyvern client. Every other Fabric session remains single-client. Network captures are capped at 2,000 requests, 256 KiB per value, and 10 MiB total. The optional `EXFILTRATION_SKYVERN_MAX_STEPS` setting defaults to 80.

Providers always see the service identity defined in `src/lib/constants.ts` (Phishing Support, `support@phishing.support`, `https://phishing.support`); it is code, not configuration, because routes pin the provider definitions that embed it. When a public report names its submitter, the name and/or email appear only in the report text as the original reporter, and Cloudflare additionally receives the submitter's country when known.

## Mail configuration

The service uses one mailbox for everything:

```text
SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
SMTP_FROM=support@phishing.support      # authenticated sender of every report
IMAP_HOST, IMAP_PORT, IMAP_SECURE, IMAP_USER, IMAP_PASS
IMAP_MAILBOXES=phishing.report,phishing.support  # every folder that receives intake mail or provider replies
IMAP_LISTEN_ADDRESS=report@phishing.support
REPLY_DOMAIN=phishing.support           # must equal the IMAP_LISTEN_ADDRESS domain
```

Each abuse email uses `SMTP_FROM` as its visible sender and a new opaque `Reply-To` such as `abuse-<48 hex>@phishing.support`, unique to one route. `REPLY_DOMAIN` must deliver into one of `IMAP_MAILBOXES` (for iCloud Custom Email Domain, enable **Allow All Incoming Emails**; see Apple's [catch-all guide](https://support.apple.com/guide/icloud/allow-all-incoming-emails-mm9e3ee0680f/icloud)). Do not substitute plus-addressing.

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
acceptance. Legacy/unverifiable drafts are stopped rather than resent, avoiding
an accidental replay of an old analysis-only message. Drafting and reply
classification use the analysis endpoint (`OPENAI_API_KEY`,
`OPENAI_API_BASE_URL`, `OPENAI_MODEL`); `OPENAI_TIMEOUT_MS` bounds each call
(5 seconds to 5 minutes, default 45 seconds). The deterministic template works
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
