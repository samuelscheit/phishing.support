# One case per redirect chain

Status: accepted (2026-11-23). Replaces the per-site hand-off introduced in
`f0ceb13` and `c86f8c9`.

## Problem

A website case belongs to one site. When the capture or the visit ends on
another site, today's analysis hands the capture off (`handOffRedirectedCapture`)
to that site's case and the submitted case becomes `redirected`. Evidence of one
chain is then scattered over several cases, the intermediate pages have no
capture of their own, a destination that already has a case discards the new
capture (dedupe onto a stale case), and the chain is never judged as a whole.
Example: `onlinesafetyall.com` → `wtrck.com` → `ultimateprizesearch.com`
(fake "Your Financial Assist … complete final step" application) → `wtrck.com`
→ `sdsecurenetwork.com` → `miamitrk.com` (`a=15065&c=181082`) →
`zatos.com` checkout (`affid=15065`). The merchant checkout is judged benign,
the lure only "redirects", nothing is reported, and nobody is asked to ban
affiliate 15065.

## Decisions

1. **One case per chain.** The submitted case owns the whole chain: every
   response, every page shown, every site. No hand-off, no `redirected`
   status, no `redirectSubmissionId`, no `source: redirect:<id>` children.
2. **Complete chain evidence.** Every navigation response is recorded
   (status, `Location`, timing). Every document response's body is kept
   (raw HTML from the network, even for an interstitial that navigates on
   at once). Every page that was shown gets the usual capture: MHTML,
   screenshot, stamped screenshot, evidence manifest + RFC 3161 token.
3. **Judgement per site, inside the case.** Each site of the chain gets its
   own assessment (`siteAssessments` already keys by hop). The chain gets a
   verdict of its own (see 5).
4. **Reports per site, deduplicated across cases.** Each reportable site of
   the chain gets its own report (one target: that host) to its host and
   registrar, as today. A report for a target that already has an open
   report from another case is not created again; the existing report is
   linked to this case with an event naming it. Redirectors of a confirmed
   page are taken from the same case's chain.
5. **New finding: deceptive funnel.** A chain whose lure misrepresents what
   the visitor is doing (fake application, prize, account or security
   warning, fake verification) and leads, through tracking links, into a
   paid offer or a merchant checkout. Corroborated like phishing: verbatim
   quotes from the lure pages. It is not phishing and is not reported to
   hosts as phishing.
6. **Funnel reports go to the merchant and the affiliate network, fully
   automatically.** Affiliate ids and tracking platforms are extracted from
   the chain's tracker URLs (e.g. CAKE `?a=<affiliate>&c=<creative>`,
   Everflow `/<affiliate>/<offer>/?sub1=` (both IDs encoded), TUNE/HasOffers `aff_id`,
   merchant landing `affid=`). The recipients are the end merchant's
   compliance/affiliate/abuse contact and the operator of the tracking
   network, resolved automatically. The report names the affiliate ids,
   the full chain with timestamps and the lure evidence, and asks to
   terminate the affiliate.

## Consequences

- Several lures leading to one kit are several cases; deduplication moves
  from cases to reports (decision 4).
- Cloaking judged by "destination verdict" (`settleCloakedRedirect`) is
  decided inside the case: a scripted jump from the residential exit to a
  page judged harmless fails the case as suspected cloaking.
- The redirector watch derives the redirector from the case's own chain.
- UI: one navigation timeline per case with every hop, its captures and
  the site's verdict; the redirected panel and "analyzed in its own case"
  links disappear.
- Stored `redirected` cases take their final destination case's outcome
  (following chains of hand-offs): a reported destination makes them
  `reported`, joined to its reports (`abuse_report_cases`); otherwise its
  status is copied. Their info names that case. No compatibility code for
  the old shape.
- Model cost grows with the chain: every page shown is classified until its
  site is found reportable (a walk through a lure, a few interstitials and
  a kit is about 13 classification calls), each revisit (as a phone, from
  another network, after a cloaked destination) walks and classifies again,
  and a chain that passed a tracking link to a merchant page adds one
  funnel classification. Pages of a site already found reportable are not
  classified again.
- One cross-case link for every subject: a later case joins the open report
  of a site (30 days) or of a funnel's business and affiliate (90 days)
  through `abuse_report_cases`, unless that report ended unsent, awaits an
  operator (`needs_human`), or its target's takedown was confirmed by our
  site checks. A joining case still reports what only its visit saw (its
  redirector and data drops) against the joined report.
- Campaigns link sites, not cases: a member is a (case, site report) pair,
  so a case that confirmed two sites can sit in two campaigns, and a case
  that only joined another case's report is a member through that report,
  linked by its own evidence.
- Keeping every document body means holding every main-frame document in
  the Fetch domain. Bodies are read as a stream within a byte cap and a
  time bound, and the page is answered from DevTools with the bytes read:
  a tarpit cannot hold the visit or its memory, but a fulfilled page has no
  remote address (public-like to Chromium's Local Network Access), and a
  page past the cap is shown cut off and kept without its body.
