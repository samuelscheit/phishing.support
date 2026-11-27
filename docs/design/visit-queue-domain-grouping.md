# Durable website-visit queue and site-group collection

Status: approved (answers to the open questions are folded in, see "Decisions" at the end); implemented in the shipping order below. Incident: reporter IP 5.189.203.86 submitted about 100 subdomains of `slon10.to` in 90 minutes. Every host became its own case, and about 80 visits ran in parallel. A restart then failed all of them, and the auto-retry sweep started them again together.

## 0. What the code does today

| Concern | Today | Where |
|---|---|---|
| Single entry point for analysis | `analyzeWebsite` | src/lib/website/analysis/ai.ts:62 |
| New case | inserts `status:"running"`, then `startAnalysis(...).catch()` detached | src/lib/submissions/website.ts:94-122 |
| Dedupe | full hostname (`websiteSubmissionDedupeKey` → `websiteSite`) | website.ts:~105, src/lib/website/info/site.ts:75-83 |
| Callers | HTTP route.ts:37 · mail/ai.ts:89-93 · origin/report.ts:343-357 · origin/kit_job.ts:65-92 (awaits inside `discovery` lane) · origin/redirector_watch.ts:258-275 (awaits inside `external` lane) | |
| Retry | `retryWebsiteAnalysis` → `claimRetry` (failed/invalid→running), detached start | website.ts:132-200, src/lib/submissions/retry.ts:31-75 |
| Auto-retry | `failWebsiteAnalysis` writes `data.website.autoRetry`; a 60 s `setInterval` (`runDueWebsiteAutoRetries`, limit 10) restarts due cases | failure.ts:27-60, website.ts:39-70, entities/submissions.ts:170 |
| Restart | `failAllRunning()`, then `retryInterruptedWebsiteAnalysis` for each case | src/server.ts:31-38, entities/submissions.ts:78, ai.ts:413-421 |
| Job system | `abuse_jobs` with lease, heartbeat, recovery, retry and defer; lanes have fixed slots | abuse/schema.ts:362-386, persistence/jobs.ts:145-200, worker/index.ts:155-240, worker/jobs.ts:47-105 |
| Report dedupe | per full host (`ReportSubject {site}`, ordinal-0 target); later cases join through `abuse_report_cases` | persistence/reports.ts:52-130, 276-290 |
| Campaign membership | (submission, report) pairs; joined cases become members through `listCaseSites`; clustering is union-find over linking indicators | campaign/schema.ts:52-80, repository.ts:45-65, cluster.ts:51-102 |
| Homepage | `groupByCampaign` over `card.campaign` (the case's first `campaign_members` row) | submissions/campaign_groups.ts:14-30, entities/submissions.ts:124-142 |
| PSL | `tldts` 7.4.12 is already a dependency. `hostRegistration` (private section, `UNLISTED_PLATFORMS`, `hasPathTenants`) returns `{domain}` or `{platformTenant}` | src/lib/network/registered_domain.ts:41-68 |

Two gaps matter. Nothing durable says "visit pending": the `running` row is the only state. And nothing groups hosts by registrable domain: targets, subjects, dedupe and campaigns all work per host. The incident's "held" cases are cases with status `failed` and `autoRetry` set; there is no `held` status.

---

## Feature 1: durable website-visit queue

### Decision: reuse the abuse worker's job executor, do not build a separate queue

| | Reuse `abuse_jobs` with a new `visit` lane | Separate `website_visits` table and runner |
|---|---|---|
| Lease, heartbeat, stale recovery, shutdown fencing, defer-without-attempt (browser down), timeout | already there (index.ts:196-240, jobs.ts:341-366, retry.ts) | would be written a second time |
| Restart recovery | `recoverStaleJobs` already runs at `start()` | new code |
| Kit-sibling and redirector visits | stop holding a lane slot while the visit runs (see below) | same |
| Cost | `fair_key` and `serial_key` columns plus a fair-share claim; event writes for jobs without a report | whole subsystem |

**Choice: reuse.** The executor is the hard part and it already exists. The per-route guard in `claimNextJob` (persistence/jobs.ts:161-172) is the same mechanism a per-domain serial guard needs, so I generalize it instead of copying it.

One problem has to be solved: `abuse_events.report_id` is NOT NULL (abuse/schema.ts:~394), and `claimNextJob`, `requeueJob`, `recoverStaleJobs` and `completeJob` call `recordEvent(reportId!)`. A public visit job has no report. The fix is to route those calls through one `recordJobEvent(tx, job, …)` that writes nothing when `job.reportId` is null. The visit's history already lives on the case (`analysis_runs`, `submission_retries`). Making `abuse_events.report_id` nullable would also work, but it turns a report audit trail into a generic log, so I'd avoid it.

### Schema (migration 0036_visit_queue)

- `abuse_jobs.fair_key text null`: the share a job counts against.
  - `ip:<reporterIp>` when the case has a reporter IP. Derived work (kit, origin and redirector siblings) passes the original report's requester IP, so a flooder's follow-up work also counts against the flooder.
  - Otherwise `source:<source prefix>` (`email`, `kit-sibling`, …).
- `abuse_jobs.serial_key text null`: at most one running job per key. Backfill: `update abuse_jobs set serial_key = 'route:' || route_id where route_id is not null`. The `routeId` guard in `claimNextJob` becomes the `serial_key` guard, so it is one mechanism. Visit jobs use `site:<siteGroup>` (Feature 2).
- Index `abuse_jobs_lane_fair_idx (job_type, status, fair_key)` and `abuse_jobs_serial_idx (serial_key, status)`.
- `abuse_job_types` gets `visit_website`.
- `submissionStatus` gets `queued` (src/lib/db/schema.ts:14). The default stays `running` only if email needs it; better to make the default explicit at every insert.

### Claim: fair share plus serial guard

`claimNextJob(owner, leaseMs, filter)` (persistence/jobs.ts:145) gets `filter.fairShare?: { perKeyLimit: number }`. The current approach (32 oldest candidates in FIFO order) cannot be fair: with 100 queued flood jobs, all 32 candidates belong to the flooder. For lanes with `fairShare`, one SQL statement in the same immediate transaction does this:

1. Due candidates of the lane's types (queued and due, or running with an expired lease, as today). Drop any candidate whose `serial_key` has a running job with a live lease (`not exists`).
2. Count running jobs per `fair_key` with a live lease. Drop keys at or above `perKeyLimit`.
3. Order by (running count of the key ascending, `next_attempt_at`, `created_at`) and take 1.

This is work-conserving: a lone flooder gets `perKeyLimit` slots. As soon as a second reporter has a due job, that reporter wins the next free slot (fewer running). **`perKeyLimit = max(1, WEBSITE_VISIT_CONCURRENCY - 1)`**, which keeps one slot that a single key can never take. Nothing is rejected.

### Lane and policy

- `worker/jobs.ts:47`: `JOB_LANES` gets `"visit"`, and `JOB_POLICY.visit_website = { lane: "visit", supplementary: true, minTimeoutMs: 60 * MINUTE }`. A walk alone can take 20 minutes; the deadline must exceed the longest analysis.
- `worker/index.ts:169` slots: `visit: this.visitConcurrency`, read from env `WEBSITE_VISIT_CONCURRENCY` (default 4, max 16), the same pattern as `controlConcurrency`. `laneFilter("visit")` adds `fairShare`.
- `analyzeWebsite` must honour `options.signal` (it gets the job's AbortController). Otherwise a timeout re-queues a job whose visit is still running.

### New module `src/lib/website/visit_queue.ts`

```ts
type VisitTrigger = "initial" | "manual" | "automatic";
enqueueWebsiteVisit(tx | db, { submissionId, trigger, notBefore?, fairKey, siteGroup }): void
  // enqueueJobOnce, dedupeKey `website-visit:<id>`: at most one live visit job per case
runWebsiteVisit(job, signal): Promise<void>      // handler for visit_website (worker/jobs.ts dispatch table ~:198)
websiteVisitQueueState(submissionId): Promise<VisitQueueState | undefined>  // UI position
ensureWebsiteVisitJobs(): Promise<number>        // startup reconciliation (called in AbuseWorker.start next to ensureLivenessChecks)
```

`runWebsiteVisit` does three things:

1. It calls `decideSiblingVisit` (Feature 2) and may collect the case instead of visiting it.
2. For `initial`, it calls `analyzeWebsite({ submissionId, url, instructions, reporter…, signal })`.
3. For a retry, it builds the options from the stored case using `retryAnalysisOptions(submission)`, the artifact-reuse half of today's `retryWebsiteAnalysis` (website.ts:145-200), split out. Artifacts are read at run time, not at enqueue time.

The job completes when the analysis returns. The analysis records its own failure (`failWebsiteAnalysis`).

### Every start goes through the queue

| Path | Change |
|---|---|
| `createWebsiteSubmission` (website.ts:94) | Inserts `status:"queued"` and calls `enqueueWebsiteVisit` in one transaction (`SubmissionsEntity.create` takes a `tx`). The `startAnalysis` parameter is removed. Returns `{ id, status }`. |
| HTTP route.ts:37 | Response `{ stream_id, status: "queued" \| "collected", queue_position? }`. |
| mail/ai.ts:89 | No change; it already only creates the case. |
| origin/report.ts:347 | No change. |
| kit_job.ts:65-92 | Drop `analysis` and its await. The job only creates the case, so the `discovery` slot is no longer held during the visit. The `retiredKitHashes` check stays. `ANALYSIS_SPACING_MS` in kit_search.ts:179 becomes pointless; remove it. |
| redirector_watch.ts:258 | Create the case. If its status is `queued` or `running`, throw `VisitPendingError`. `jobWaitOf` (worker/retry.ts:28) maps it to a defer of `browserWaitDelayMs` that spends no attempt. The re-run finds the case through the `visit` dedupe key (this works today) and reads the result. This frees an `external` slot for the visit's duration. |
| `retryWebsiteAnalysis` (website.ts:132) | Validate, then `claimRetry` moves failed/invalid to **`queued`** (retry.ts:65 `claim` `to` param), then enqueue `trigger:"manual"`. Instruction replacement stays at claim time. |
| `failWebsiteAnalysis` retry branch (failure.ts:~50) | Keeps writing `autoRetry {attempts, nextAttemptAt, reason}` for display and enqueues `trigger:"automatic", notBefore: nextAttemptAt`. When claimed, `runWebsiteVisit` performs `claimRetry(…, "automatic")`; a refusal (reported meanwhile, manual retry) ends the job and clears `autoRetry`, as website.ts:50-56 does now. |
| **Removed** | `runDueWebsiteAutoRetries`, `startWebsiteAutoRetries`, `AUTO_RETRY_POLL_MS` (website.ts:31-71), `SubmissionsEntity.listDueWebsiteAutoRetries` (entities/submissions.ts:170), the server.ts:43 call, `retryInterruptedWebsiteAnalysis` (ai.ts:413-421) and its loop in server.ts:31-38. |
| Restart | `failAllRunning` becomes `failRunningEmails` (emails are out of scope). Website rows are left as they are: `recoverStaleJobs` re-queues their visit jobs, and `ensureWebsiteVisitJobs` repairs the rest. |

`ensureWebsiteVisitJobs` is idempotent and runs on every start:

- a website case that is `queued`/`running` without a live visit job gets one (`initial` if it never had a run, otherwise `automatic`). The case goes back to `queued`.
- a `failed` case with `autoRetry.nextAttemptAt` and no job gets one. This is also what migrates today's ~70 held production cases.

Endless crash loops: a visit that kills the process (OOM) would be recovered forever, because `recoverStaleJobs` re-queues without spending an attempt. For the `visit` lane, recovery increments `retry_count`. After 3 interruptions, `runWebsiteVisit` fails the case with today's "cut off N times" text, which replaces `retryInterruptedWebsiteAnalysis`.

### UI and stream

- `SubmissionStatus.tsx:21-67`: `queued` badge in neutral outline with a Clock icon. Labels:
  - "Queued · #N"
  - "Waiting for slon10.to sibling" (blocked by the serial key)
  - for a `failed` case with a future job: "Retrying at HH:MM" from `autoRetry`
- `SubmissionFilterChips` "Running" chip covers `running` + `queued` (`SUBMISSION_FILTERS` in list.ts).
- `SubmissionDetail.visitQueue = { position, waitingFor?: { submissionId, host }, notBefore? }` from `websiteVisitQueueState`.
- Position under fair share, for own-key index k (1-based among this key's due queued jobs): `ahead = (k-1) + Σ_{other keys} min(queuedBefore(key), k)`. This is exact for round-robin, ignoring timing. Jobs blocked by a serial key report `waitingFor` instead of a position.
- `SubmissionPageClient.tsx:64`: `isQueued`. `useSubmissionDetail` polls every 10 s while queued (verify its current polling). `useLiveVisit` keeps `enabled` only for `running`.
- Stream: `stream_id` stays the case id and is returned at once. SSE `/api/stream/[id]` subscribes before anything is published; keep-alive holds a queued connection open, and events start when the job claims. `runWebsiteVisit` publishes `analysis.step {step:"started", progress:0}` first, so API clients and the progress view see the transition. No per-claim position broadcasts: 100 publishes per claim for no real gain.

---

## Feature 2: group by site group (registrable domain, PSL incl. private)

### Site group

New pure function in src/lib/network/registered_domain.ts:

```ts
/** The site group of a URL: its registrable domain, or for a platform tenant (pages.dev, github.io, a sites.google.com path tenant), an IP, or an unlisted name, its own site. */
export function siteGroupOf(url: string): { key: string; domain?: string }
  // hostRegistration(host): {domain} → { key: domain, domain }
  //                          {platformTenant} / undefined → { key: websiteSite(url) }
```

This reuses `hostRegistration`, which already applies the private PSL section, `UNLISTED_PLATFORMS` and `hasPathTenants`. Shared hosts therefore stay per tenant, and an IP is its own group. Do not use `security.ts:156 registrableDomain` (`allowPrivateDomains:false`).

Schema (migration 0037_site_groups): `submissions.site_group text null` plus index `submissions_site_group_idx (site_group, status)`. SQLite has no PSL, so the backfill is TS: `backfillSiteGroups()` on worker start, for rows where it is null. Set at insert in `createWebsiteSubmission`.

### Rule: `decideSiblingVisit(submission)` in new `src/lib/website/site_group.ts`

The rule is evaluated at claim time inside `runWebsiteVisit`, not at submit, so it always sees current sibling outcomes. It also runs once at submit, so an already-collectable case never enters the queue.

1. **Bypass:** `rereport`, a manual "visit this host" retry, a case whose group has no `domain` (tenant or IP), or a site group equal to the case's own host's only case. → **visit**.
2. **Anchor:** the oldest sibling case in the group with status `reported` whose site report is joinable (not in `UNJOINABLE_REPORT_STATUSES`, younger than `REPORT_JOIN_WINDOW_MS`) **or** taken down (`TAKEN_DOWN_STATES` site check). → **collect into the anchor**, with no visit. No exception for old or possibly hacked domains (decision 3).
3. **Running sibling:** handled structurally. The visit job's `serial_key = site:<group>`, so only one sibling visits at a time, and the rest stay queued ("Waiting for …").
4. **Inconclusive siblings:** count distinct-host siblings whose visit ended `invalid` or `failed`, failed meaning exhausted or with an auto-retry pending. A pending auto-retry counts, because otherwise one flaky host would block the group for 24 h of browser-outage backoff. If **SIBLING_TRIAL_LIMIT = 5** is reached → **collect as inconclusive** (no anchor). Otherwise → **visit**.

Why 5 (decision 2): wildcard sibling hosts almost always serve the same kit, so one invalid result is often cloaking or a dead host and worth more tries; after five different hosts show nothing, the rest would burn about 3 minutes of browser time each to repeat the same verdict. Manual retry stays available on every collected case.

### Collected case

The new submission status `collected` is used instead of a bare URL record. The reporter got a `stream_id` and the case keeps its own dedupe, reporter metadata and page. That makes the reporter's URL a real case, so every existing join path (joinedCases, campaign membership, details page) works unchanged.

`data.website.collected = { reason: "sibling_reported" | "siblings_inconclusive", siteGroup, intoSubmissionId?, reportId?, at }`.

`collectIntoAnchor(caseId, anchor)` runs in one transaction:

- status `collected`, `info` = "Not visited: slon10.to is already reported (case X)".
- deletes the case's queued visit job and clears `autoRetry`.
- `joinCase(tx, anchor.reportId, caseId, …)`, the existing helper in reports.ts:276, exported. The event `report.case_joined` gets `data.collected: true`.
- `queueCaseSiteLinks(caseId)` (campaign/queue.ts:~19). `listCaseSites` already includes joined cases (repository.ts:55-61), so the case becomes a campaign member `(caseId, anchor.reportId)` in the anchor's campaign. **No campaign schema change.**

`siblings_inconclusive` cases join nothing. When any sibling later becomes `reported`, the hook `onSiteGroupReported(siteGroup)` collects them, together with every still-queued sibling, into the new anchor. It is called where a website case's status turns `reported` (the analysis reporting step; find the exact site with explore when implementing).

### Registrar report covers every host

Targets stay per host. Changing `normalizeAbuseTarget` to registrable domains would break hosting routes and liveness, which are per host or IP. Instead:

- `AbuseRepository.listCollectedHostUrls(reportId)` returns the joined cases' URLs whose host differs from the target host.
- `mail/draft.ts bodyFor` (:432-458) gets `relatedUrls`, rendered only for **registrar** routes (domain routes in `finalizeDomainRouteResolution`, provider `…:registrar`) as "Other hosts under slon10.to seen by reporters:" followed by a list. The URLs are also added to `allowedSummaryUrls` (:525). Hosting routes don't get the list, because their mail is about one host or IP.
- `icannComplaintText` (escalation/notice.ts:165) and the follow-up/escalation drafts get the same list, so later steps cover new hosts.
- Per the rule ("nothing more"): a registrar mail that was already sent is **not** re-sent because a host was collected later. New hosts reach the registrar with the next follow-up or escalation.
- Liveness: collected hosts get no checks of their own. The anchor report's checks decide, and a registrar takedown covers them all.

One registrar mail per domain (decision 5): a website report's subject becomes the case's **site group**, not its host. `subjectReports` (persistence/reports.ts) matches ordinal-0 targets whose site group equals the subject, so a later sibling that was visited and confirmed (a trial sibling, "Visit this host", a divergence re-visit) joins the first open report of the domain with its own capture as evidence instead of mailing the same registrar again. Its URL then shows in the registrar list above. Trade-off: a sibling on another hosting IP gets no hosting report of its own while the domain report is open.

### Campaign: same registered domain links

`campaignIndicatorKinds` (campaign/schema.ts:18) gets `registered_domain` (`links: true`). `extractIndicators` (campaign/indicators.ts) emits it from `siteGroupOf(member url).domain`, never for tenants or IPs. Today's 6 reported slon10.to cases are 6 sites with possibly unrelated indicators; this kind unions them into one campaign through the existing `assignCampaigns`, with no special case. Members need relinking once after deploy; the existing rules sweep (`enqueueRulesSweep`, worker/index.ts:166) runs when the rules change.

### Homepage tile "slon10.to · N hosts"

- `SubmissionsEntity.listCards` (entities/submissions.ts:124-142) also selects:
  - `siteGroup`
  - `siteGroupSize = count(*) from submissions peers where peers.site_group = s.site_group and peers.kind='website'`
  - for campaigns: `campaignHosts = count(distinct host of member cases)` and `campaignDomains = count(distinct site_group of member cases)`
- `groupByCampaign` (campaign_groups.ts:14) becomes `groupCards`. Key = campaign id. Otherwise, when the card's site group is a registrable domain with `siteGroupSize ≥ 2`, key = `site:<group>`. This covers queued, running and inconclusive siblings that are in no campaign yet. A tile where all members share one domain is labelled "slon10.to · N hosts", with a status summary (e.g. "6 reported · 87 collected · 1 visiting"). Mixed-domain campaigns keep today's tile.
- Public campaign page (campaign/public_view.ts:296 groups sites by `getDomain`): under a site, list "Also on N hosts" from collected cases.

### Collected host that turns out to be different (wildcard serving different content)

- **Manual escape hatch:** the retry button on a collected case reads "Visit this host". `retryWebsiteAnalysis` accepts `collected` (retry.ts:36). In one transaction it removes the case's `abuse_report_cases` row and its campaign membership, clears `collected`, and enqueues `trigger:"manual"` with the gate bypassed. The visit then reports its own host as usual: a different site gets its own report, and the same kit joins the campaign through indicators again.
- **Automatic (decision 4):** one cheap HTTP fetch per collected host, without a browser: a `probe_collected_host` job (liveness lane) runs `checkSite` on the collected URL and compares its page fingerprints with the anchor report's judged page (`site_check_page_fingerprints`, migration 0035). Same content, or a host that is down → stays collected. Different content → the case is un-collected and a real visit is queued under the same serial and fair rules (its fair key is the case's own).

---

## Production one-off (slon10.to: 6 reported, 9 invalid, ~70 failed/held, ~12 running)

This uses generic code, not a bespoke script: `scripts/collect_site_group.ts <siteGroup> [--include-settled]` calls `collectSiteGroup(siteGroup, { includeSettled })`, the same function `onSiteGroupReported` uses.

1. Deploy Features 1 and 2. On start, `backfillSiteGroups` fills `site_group`. `ensureWebsiteVisitJobs` turns the 70 held cases and the ~12 interrupted running cases into `queued` jobs; on claim, `decideSiblingVisit` would collect them into the anchor anyway.
2. Run the script with `--include-settled`. Anchor = oldest reported case with a joinable report. All non-reported cases (queued, failed, **and the 9 invalid**) are collected into it with reason `sibling_reported`; the invalid cases keep their artifacts and visit history. A host of a reported wildcard domain that showed nothing was most likely cloaked.
3. The rules sweep relinks; the `registered_domain` indicator puts the 6 reported cases into one campaign, and the collected cases follow through their joins.
4. Verify on production: one homepage tile "slon10.to · ~100 hosts", no `visit_website` jobs left for `site:slon10.to`, and the anchor report's next registrar follow-up lists the hosts.

---

## Sequencing (each step ships and runs on its own)

1. **1a**: `serial_key`/`fair_key` columns, the route guard moved to `serial_key`, `recordJobEvent`, fair-share claim. No behaviour change for existing lanes.
2. **1b**: `visit` lane, `visit_website`, `visit_queue.ts`, all start paths, status `queued`, removal of the sweep and restart failure, `ensureWebsiteVisitJobs`. This alone fixes the incident's parallelism and restart storm.
3. **1c**: UI (badge, position, chip, detail polling, `started` event, API response).
4. **2a**: `site_group` column and backfill; visit jobs get `serial_key = site:<group>`. This alone serialises siblings.
5. **2b**: status `collected`, `decideSiblingVisit`, `collectIntoAnchor`, `onSiteGroupReported`, "Visit this host" retry, registrar mail list.
6. **2c**: `registered_domain` indicator, homepage tile, public campaign hosts.
7. **One-off** on production.

---

## Test plan (bun test, real sqlite as in the existing entity tests)

**Queue (persistence/jobs.test.ts, website/visit_queue.test.ts)**

- Fair share: 100 jobs of key A plus 1 job of key B enqueued after them, cap 4. Key A never holds more than 3; B is claimed on the next free slot. Two keys each get claims alternately.
- Serial key: two due jobs on `site:x`; the second is not claimable while the first's lease lives, and is claimable after the lease expires or the job completes. The route guard keeps working as `serial_key=route:<id>` (existing route tests unchanged).
- Lease expiry during a visit → recovered; visit lane `retry_count` increments; the 3rd interruption fails the case with the "cut off" text.
- `recordJobEvent` writes no event for a null `reportId` and does not throw, through claim, retry, defer and complete.
- `createWebsiteSubmission`: insert and enqueue are atomic (a forced enqueue failure leaves no row). A duplicate URL returns the existing id and no second job. `rereport` creates a new case and job.
- Retry: manual claim → `queued` plus one job; a double request → one job (dedupe key); cooldown as before. An automatic retry refused because the case was reported meanwhile → job ends, `autoRetry` cleared.
- `failWebsiteAnalysis` with retry → a job with `next_attempt_at = autoRetry.nextAttemptAt`; browser-outage delays preserved.
- `ensureWebsiteVisitJobs`: running without a job → queued plus job; failed with `autoRetry` and no job → job; running twice is idempotent; email rows untouched.
- Kit sibling job returns before the visit. Redirector job: case queued → defers without spending an attempt; case settled → reads status and destination.
- Abort: job timeout aborts `analyzeWebsite` through the signal; no visit continues after re-queue.
- Queue position: formula cases (1 key; 3 keys with unequal queues; a delayed job shows `notBefore`; a serial-blocked job shows `waitingFor`).

**Site group (registered_domain.test.ts, site_group.test.ts)**

`siteGroupOf` must return:

| Input | Group |
|---|---|
| `a.b.slon10.to` | `slon10.to` |
| `x.co.uk` | `x.co.uk` |
| `kit.pages.dev` | `kit.pages.dev` |
| `foo.workers.dev` | `foo.workers.dev` |
| `user.github.io` | `user.github.io` |
| `sites.google.com/view/abc` | the tenant path |
| an `UNLISTED_PLATFORMS` host | the tenant |
| IPv4 / IPv6 | the IP |
| a punycode host | its registrable domain |
| a trailing dot / uppercase host | normalized form |

`decideSiblingVisit` must:

- collect when an anchor is reported, or reported and taken down
- visit when the anchor's report is older than 30 days and not taken down
- visit for an established domain (registered more than 365 days ago)
- visit for a tenant on pages.dev even with a reported sibling tenant
- with `SIBLING_TRIAL_LIMIT`: visit for invalid×2, collect-inconclusive for invalid×3, and count a failed sibling with auto-retry pending as an attempt
- convert inconclusive and queued siblings to `sibling_reported` when `onSiteGroupReported` runs
- let `rereport` bypass the rule

`collectIntoAnchor`:

- one `abuse_report_cases` row; the campaign member appears after the link job
- `joinedCases` of the anchor report lists it
- the queued job is deleted and `autoRetry` cleared
- a second call is idempotent

"Visit this host": the join and membership are removed, the visit runs past the gate, and a different site gets its own report.

Registrar draft lists the collected host URLs; the hosting draft does not; the summary URL allow-list includes them.

`registered_domain` indicator unions two reported subdomains into one campaign; it is never emitted for tenants or IPs.

`groupCards`: a campaign tile with one domain is labelled "domain · N hosts"; site-group grouping for non-campaign siblings; mixed campaigns unchanged; tenants never grouped by platform.

**One-off:** a fixture with 6 reported, 9 invalid, 70 failed (autoRetry) and 12 running hosts of one domain plus one other reporter's case. After `collectSiteGroup --include-settled`: one campaign, 94 collected joined to the anchor, no visit jobs for the group, and the other reporter's case untouched.

---

## Decisions (user, after review)

1. Always reserve one slot: a single fair key never gets more than cap−1 slots, even when idle.
2. Try 5 distinct hosts per site group; a failed sibling waiting on auto-retry counts as one attempt.
3. No exception for old or hacked domains: always collect once a sibling is reported.
4. Cheap HTTP probe for every collected host; different content queues a real visit.
5. One registrar mail per domain: later reported siblings join the first report.
6. Kit, origin and redirector siblings inherit the parent's fair key.
7. Rename `abuse_jobs` to `jobs` (migration and every import, no aliases).
8. The slon10.to one-off also collects the 9 invalid cases.

## Open questions (answered above)

1. **Per-reporter cap:** reserve one slot (`perKeyLimit = cap-1`, my default) or allow a lone flooder all 4 slots (fully work-conserving; a newcomer then waits up to one visit, about 3 min)?
2. **Sibling trial limit:** 3 distinct hosts before collecting the rest as inconclusive? Should a failed sibling with auto-retry pending count as one (my default: yes)?
3. **Compromised legitimate domains:** a phishing page on `hacked.uni.edu` would make the gate collect `www.uni.edu` unvisited. My default: no collection when the domain is known to be registered more than 365 days ago; unknown age (many ccTLDs, `.to`) still collects. Alternatives: always collect (the user's literal rule), or require ≥2 reported siblings for old domains.
4. **Wildcard divergence:** add the cheap no-browser fingerprint probe per collected host (one HTTP check each), or rely on manual "Visit this host" only (default)?
5. **Registrar dedupe** for subdomains that were each fully reported (the 6 in the incident sent 6 registrar mails): in scope now or a follow-up?
6. **Fair key for derived work:** count kit, origin and redirector siblings against the original reporter's IP (default) or give the system its own `source:` share?
7. **Naming:** `abuse_jobs` now also runs non-abuse visits. Rename to `jobs` now (a large mechanical diff) or later?
8. **One-off:** collect the 9 already-invalid hosts too (default yes, they keep their artifacts), or leave them as "No threat found"?

## As implemented (differences from the design above)

- **Commits:** 1a and 1b shipped as one commit (the `jobs` rename and the visit lane touch the same files); then 1c, 2a, 2b, 2c.
- **Inconclusive hosts** are status `invalid` with `collected.reason = "siblings_inconclusive"`, not `collected`: `collected` always means "named by its domain's report". A report of the group later collects them.
- **Reported siblings keep their own reports.** Hosts reported before site groups existed (the 6 slon10.to cases) stay `reported` with their own reports; they join one campaign through the `registered_domain` indicator (CAMPAIGN_RULES_VERSION 9 relinks every site once on start). New ones join the first open report of the domain (decision 5).
- **Registrar host list** goes into the drafted abuse mail of registrar routes (`isRegistrarRoute`: provenance `registrar_rdap`, `domain_rdap`, `domain_whois`). Registrar web forms (`provider_submission` payloads) and the ICANN complaint text do not list the other hosts yet.
- **Divergence probe** compares one plain fetch of the collected host with the report's recorded content (`verifyReportedContent` fetch tier, `record: false`); it re-visits only when the reported host itself still matches a plain fetch, otherwise a plain fetch cannot tell and the host stays collected.
- **Queue position** follows the fair-share turn order; jobs blocked behind their site group's running visit show "Waiting", and a queued job whose group has another queued host ahead of it counts that host as ahead.
- **Homepage**: a campaign whose members share one site group is titled by it with its host count; a domain's queued or running hosts join that tile; a group's cases in no campaign are one tile linking the newest case.
- **One-off:** `docker exec -w /app <container> bun scripts/collect_site_group.ts slon10.to --include-settled` (`--dry-run` first). Running hosts are not touched: after the deploy's restart they are failed into their automatic retry and collected when it comes due.
