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
- Stored `redirected` cases are migrated to `invalid` with their info kept;
  no compatibility code for the old shape.
