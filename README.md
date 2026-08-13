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
- Perform a controlled preflight: send one report to a test recipient, reply to its generated `Reply-To`, and verify both messages and attachments appear in the submission’s Reports tab.

Incoming mail is assigned only by an exact generated recipient address, an exact outbound RFC `Message-ID` in `In-Reply-To`/`References`, or a unique diagnostic thread header. The listener never guesses from sender, subject, or quoted content. Forwarded messages to `report@phishing.support` continue through the normal submission intake path. Other messages are recorded as ignored in the IMAP ledger, marked read, and left in the mailbox.

Do not substitute plus-addressing if catch-all routing is unavailable. Use a dedicated reply subdomain backed by a catch-all-capable inbound provider while retaining the authenticated SMTP sender.

## Privacy note

Only submit emails or links that you are allowed to share publicly. The project is intended to help protect users and organizations - do not use it to probe private systems or to impersonate abuse inquiries.

## Contributing

Contributions, bug reports, and improvements are welcome. Please open issues or pull requests on the project's repository. When contributing, keep changes focused and include tests where appropriate.
