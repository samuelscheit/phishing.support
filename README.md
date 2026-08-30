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

## Abuse-report reply correspondence

SMTP abuse reports are stored as individual correspondence threads. Each report uses the configured, authenticated `SMTP_FROM` address as its visible `From` address and a new opaque `Reply-To` address such as `case-<32 hexadecimal characters>@phishing.support`. The reply identity is random, does not contain a submission ID, and is unique to one report target.

Before enabling SMTP report delivery, configure inbound mail for the reply domain:

- Set `REPORT_REPLY_DOMAIN=phishing.support` and keep it equal to the domain in `IMAP_LISTEN_ADDRESS` (for example, `report@phishing.support`). The listener rejects a mismatch at startup.
- Keep `SMTP_FROM` as a real, authenticated mailbox in the SMTP provider. Generated identities are only `Reply-To` addresses; they are never used as `From` or as the SMTP envelope sender.
- For iCloud Custom Email Domain, enable **Allow All Incoming Emails** for `phishing.support`. This catch-all must deliver to the mailbox configured by `IMAP_MAILBOX`; confirm the mailbox/rules before rollout. See Apple’s [catch-all configuration guide](https://support.apple.com/guide/icloud/allow-all-incoming-emails-mm9e3ee0680f/icloud).
- Configure `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASS`, `IMAP_MAILBOX`, and `IMAP_LISTEN_ADDRESS` for that monitored mailbox.
- Configure `ABUSE_SMTP_HOST`, `ABUSE_SMTP_PORT`, `ABUSE_SMTP_SECURE`, `ABUSE_SMTP_USER`, `ABUSE_SMTP_PASS`, and `ABUSE_SMTP_FROM` for outbound abuse mail (each falls back to its corresponding `SMTP_*` setting when the abuse-specific key is absent).
- Perform a controlled preflight: send one report to a test recipient, reply to its generated `Reply-To`, and verify both messages and attachments appear in the submission’s Reports tab.

Incoming mail is assigned only by an exact generated recipient address, an exact outbound RFC `Message-ID` in `In-Reply-To`/`References`, or a unique diagnostic thread header. The listener never guesses from sender, subject, or quoted content. Forwarded messages to `report@phishing.support` continue through the normal submission intake path. Other messages are recorded as ignored in the IMAP ledger, marked read, and left in the mailbox.

Do not substitute plus-addressing if catch-all routing is unavailable. Use a dedicated reply subdomain backed by a catch-all-capable inbound provider while retaining the authenticated SMTP sender.

### Provider-facing email drafts

The generic verified-email route does **not** send the stored AI analysis as the
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
an accidental replay of an old analysis-only message. Configure
`ABUSE_OPENAI_API_KEY`, `ABUSE_OPENAI_API_BASE_URL`, and optionally
`ABUSE_EMAIL_DRAFT_MODEL` in the runtime environment when AI-written summaries
are desired; `ABUSE_OPENAI_TIMEOUT_MS` bounds the drafting/classification call
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

## Supplemental Netcraft reporting

Every standalone abuse report with one or more validated observed URLs creates an independent Netcraft Reporting API v3 submission route. This happens alongside normal resolver-selected provider routes and the existing eligible Google Safe Browsing supplemental route. Netcraft receives every observed URL associated with a target in one API submission; the returned submission UUID is retained with the report for auditability.

Every email confirmed as phishing is also sent to Netcraft's documented `POST /report/mail` endpoint using the original submitted RFC 822/MIME source. The original source is retained as the submission artifact and linked to the Netcraft report. Netcraft accepts messages up to 20 MiB; larger messages are recorded as a local failed report and are never sent. A durable pre-call marker prevents an interrupted or ambiguous request from being replayed automatically, while explicit API rejections remain visible as failed reports.

Netcraft's API requires a reporter email. The service uses `ABUSE_NETCRAFT_REPORTER_EMAIL`, which defaults to `support@phishing.support` in Docker deployments. It deliberately does not disclose an optional public reporter contact email. URL-only providers are not given invented URLs: a target without a validated observed URL remains eligible for its resolver-derived abuse routes, but has no Netcraft or Google Safe Browsing supplemental submission to make.

## Privacy note

Only submit emails or links that you are allowed to share publicly. The project is intended to help protect users and organizations - do not use it to probe private systems or to impersonate abuse inquiries.

## Contributing

Contributions, bug reports, and improvements are welcome. Please open issues or pull requests on the project's repository. When contributing, keep changes focused and include tests where appropriate.
