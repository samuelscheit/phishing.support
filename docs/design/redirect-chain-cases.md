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

## Offer rotation

An affiliate network's smart link sends each click to whichever offer it
rotates to. Production case 383412636961738752 shows this. Its one walk of
`onlinesafetyall.com/6RNXHT/2HSS8TK/` went through wtrck.com to a fake
application on smizeprize.com and on to the zatos.com checkout. The
reporter's own click of the same link went through safe.cloudforstorage.com
to a "Your Cloud Storage has been Disabled" card form on DigitalOcean Spaces.
A plain HTTP client is sent to yahoo.com, so only a browser walk sees either
offer.

1. **A case holds routes.** `website.routes[]` replaces the single chain.
   Each route is one walk of the submitted link: its hops, its per-site
   verdicts, its funnel verdict, its visit record and the browser and
   network that made it.
   - The first walk is route 0, and its capture files keep their names.
     Route r > 0 prefixes its files with `route{r+1}-`, as in
     `route2-website-step1.png`, `route2-chain-hop-3.html` and
     `route2-evidence-manifest.json`.
   - `website.analyzedRoute` names the case's headline route: the first
     route with a reportable site, else the first deceptive route, else
     route 0.
   - Migration 0030 moves every stored chain into route 0. No artifact is
     renamed.
2. **Only a walk that passed a tracking link is sampled.** Tracker detection
   is the funnel extraction's own. A link without a recognized tracker is
   never opened again.
3. **Sampling.**
   - Up to 3 more visits, each a new click in a new browser context with a
     different identity: Chrome on Windows, Chrome on macOS and Safari on
     iPhone, minus the first walk's browser, then the first walk's browser
     again.
   - Every visit goes through the residential exit, because a smart link's
     bot filter sends data-centre and Tor addresses to a harmless site. The
     revisits inside a sampled walk (as a phone, after a challenge) stay on
     it too.
   - No new visit starts once 30 minutes have passed since the first walk
     ended; a visit already started runs to its end.
   - Two visits in a row that show only known routes end the sampling.
   - A failed capture (the residential exit is one connection) or a failed
     walk also ends it. The first walk's findings are reported as they are.
4. **What counts as a new route.** A visit is compared, before it is walked,
   by its hops up to the first page:
   - the first site after the link that is no tracker or wrapper;
   - the site of that first page.

   A new value of either is a new route. It is walked, captured, judged
   site by site and as a funnel, and reported exactly like the first walk,
   through the same cross-case join. A repeat is kept in `website.rotation`
   with its hops as evidence of the rotation, and is not judged again.
5. **Per-route findings, one headline.** With more than one route, each
   finding in the case info is prefixed with its route, as in "Route 2 of 2,
   via safe.cloudforstorage.com: Phishing confirmed at …". The case status
   covers every route. The case page has a route selector: the page browser,
   the Navigation tab, the visit card and the archived page follow the
   selected route, while the verdict panel lists every route's findings.

Costs and limits:

- A rotating link costs up to three more browser visits on the residential
  exit, and one full walk and classification for every new route.
- A route's data drops go with the first report that route creates or
  joins. When a later route only reaches a site that an earlier route of
  the same case already reported, that report is not created or joined
  again, so the later route's data drops are not filed.
- The macOS Chrome identity is a fixed recent release (141). It has to be
  raised by hand as Chrome moves on.
