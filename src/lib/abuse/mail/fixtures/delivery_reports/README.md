# Delivery report fixtures

Real delivery reports, each returning our fixture Message-ID
`<abuse-5e5e…5e@phishing.support>` (48 hex digits) where the original returned
the sent mail's own. `fixture.ts` swaps in a test's own identities.

From production (anonymised: people, organisations and our identities replaced):

- `office365-forwarded-recipients-not-found.eml`: 2026-11-20, an Office 365
  tenant forwarded `ip.abuse@` to six mailboxes that no longer exist
  (`550 5.4.1`, DBEB). Exchange threads it to the returned mail with
  `In-Reply-To`, which made ingestion take it for a reply.
- `icloud-postfix-rejected.eml`: 2026-08-31, iCloud's Postfix returned a report
  the recipient's filter refused.
- `google-noreply-autoresponder.eml`, `bluehost-noreply-autoresponder.eml`:
  no-reply autoresponders threaded to our reports. Not delivery reports.

From [sisimai/set-of-emails](https://github.com/sisimai/set-of-emails)
(`maildir/bsd`, BSD 2-Clause License, Copyright (C) 2014 azumakuniyuki),
unchanged apart from the returned Message-ID:

| Fixture | Source |
| --- | --- |
| `exim-permanent.eml` | `lhost-exim-01.eml` |
| `exim-delay-warning.eml` | `lhost-exim-38.eml` |
| `gmail-failed-permanently.eml` | `lhost-gmail-01.eml` |
| `gmail-delay-warning.eml` | `lhost-gmail-06.eml` |
| `qmail-permanent.eml` | `lhost-qmail-01.eml` |
| `exchange2003-recipient-not-recognized.eml` | `lhost-exchange2003-01.eml` |
| `exchange2007-user-unknown.eml` | `lhost-exchange2007-01.eml` |
| `office365-user-unknown.eml` | `lhost-office365-03.eml` |
| `outlook-delay.eml` | `lhost-outlook-06.eml` |
| `postfix-temporary.eml` | `lhost-postfix-05.eml` |
| `postfix-mixed-recipients.eml` | `lhost-postfix-02.eml` |
| `opensmtpd-permanent.eml` | `lhost-opensmtpd-01.eml` |
| `opensmtpd-delay-warning.eml` | `lhost-opensmtpd-04.eml` |
