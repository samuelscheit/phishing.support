# Standalone abuse-reporting service — progress and implementation plan

**Status date:** 2026-08-13
**Overall status:** Design and targeted research are complete enough to begin implementation. The standalone service itself is **not implemented**.

This document records the agreed product decisions, the repository’s actual state, and the implementation sequence for the public automated abuse-reporting service. It is deliberately a progress record and execution plan, not a claim that `/abuse-reporting` is available today.

The authoritative design input for this work is the attached standalone-abuse-reporting specification. Its central boundary is non-negotiable:

> The new service is independent of Phishing Support’s existing phishing-submission flow. It must not create, select, or reuse cases, `submissions`, `analysisRuns`, existing website-report records, or `createWebsiteSubmission()` as its data or execution model.

## Product outcome

Create a native public service at `/abuse-reporting` with the slogan:

> unified abuse reporting for domains and server providers

Anyone may submit one or more public domains and/or IP addresses with an allegation and optional evidence. The service resolves verified abuse routes, sends reports automatically, and retains the full reporting record indefinitely.

It is not a case-management extension and it is not an embedded Skyvern UI. Skyvern is an internal execution dependency used only where a verified provider definition calls for portal automation.

### Explicit agreed defaults

| Decision | Agreed behavior |
| --- | --- |
| Audience | Public and anonymous; no login required. |
| Inputs | One or more domains and/or public IPs, allegation details, optional associated URLs and evidence. |
| Case linkage | None. It is decoupled from existing phishing-support submissions and usable by others. |
| Submitter friction | No submitter CAPTCHA, email verification, attestation, or ordinary approval/review queue. |
| External identity | Phishing Support is the normal reporting identity. |
| First portal pilot | GNAME, using the verified Phishing Support identity. |
| Submission behavior | Valid provider workflows submit automatically, including an approved provider’s final submit control. |
| Exceptional stop | Material provider-form drift ends fail-closed as `needs_human`; it is not a review queue and must not submit. |
| Generic provider policy | Existing code-owned automation first; otherwise verified abuse email, mailbox monitoring, AI reply classification, and portal escalation only after an explicit “inbox not monitored” provider reply. |
| Portal discovery | No arbitrary portal discovery or web search. Destinations come only from verified resolver contacts or the code-owned provider registry. |
| Evidence retention | Infinite. No expiry or purge job. |
| Skyvern budget | No aggregate daily, per-user, or global cost/step quota. A generous finite per-run liveness watchdog is allowed. |
| Browser strategy | Stock self-hosted Skyvern over a dedicated CDP Chrome sidecar; existing Patchright may capture evidence independently but is not Skyvern driver-level stealth. |

## Current implementation assessment

### What is absent

As of this status update, none of the standalone abuse-reporting feature is present in the application:

- No `src/app/abuse-reporting` page or bearer-token status page exists.
- No `POST /api/abuse/reports`, `GET /api/abuse/reports/:trackingToken`, or `POST /api/skyvern/webhook` endpoint exists.
- No independent abuse-reporting tables, repositories, migrations, or artifact store exist.
- No symbols/tables exist for `abuse_reports`, `abuse_targets`, `abuse_provider_routes`, `abuse_provider_runs`, `abuse_artifacts`, `abuse_mail_messages`, `abuse_mail_codes`, `abuse_jobs`, or `abuse_events`.
- `@skyvern/client` is not installed or used.
- No Skyvern adapter, webhook verification, task reconciliation, file-upload flow, TOTP handoff, or Skyvern artifact import exists.
- No provider registry, GNAME definition, exact registrar-handle matcher, portal adapter, evidence-verification contract, or GNAME code-wait serialization exists.
- No authoritative port-43 WHOIS fallback is implemented.
- No independent durable abuse-report job worker exists; request handling cannot yet persist a report and return while durable work proceeds.
- `docker-compose.yml` does not yet define the required internal `skyvern-postgres`, `skyvern`, or dedicated `abuse-browser` services.

The requested feature should therefore be described as **planned/researched, not partially shipped**.

### Existing foundations that may inform extraction

The following code is relevant implementation experience, but it belongs to the legacy phishing-submission flow and cannot become the new service’s data model or entry point.

| Existing area | Useful capability | Boundary for new service |
| --- | --- | --- |
| `src/lib/website_info.ts` | Domain/IP RDAP lookups and BGP-origin ASN enrichment through RIPEstat plus ASN RDAP. | It has no authoritative legacy port-43 WHOIS fallback and needs a standalone resolver layer with full provenance. |
| `src/lib/report/reportWebsitePhishing.ts` | Selects explicit IP RDAP or origin-ASN RDAP abuse contacts and excludes technical/admin contacts. | It is coupled to `submissions`, analysis output, legacy artifacts, and existing provider behavior. Do not call it from new abuse reports. |
| `src/lib/report/sendReportEmail.ts` | Builds canonical MIME, uses opaque reply identities, persists MIME/attachments before SMTP, and settles delivery independently. | Adapt or extract generic mail primitives only; create independent abuse mail tables, artifacts, and correlation. |
| `src/lib/imap/imap_listener.ts` and `src/lib/imap/routing.ts` | Continuous IMAP processing, deterministic reply routing, raw MIME/attachment persistence, and UID-based duplicate suppression. | Extend through an abuse-specific intake/repository contract; do not treat legacy report threads as abuse routes. |
| `src/lib/report/correspondence.ts` | Address/header normalization, opaque reply identity generation, response classification helpers, and inbound HTML sanitization. | Reuse only generic pure helpers where suitable; abuse workflow state remains independent. |
| `src/server.ts` | Starts the legacy IMAP listener and recovers legacy `running` submissions at process startup. | It has no durable job lease worker, abuse recovery, or Skyvern reconciliation lifecycle. |

The existing database is centered on `submissions`, `analysis_runs`, `artifacts`, provider reports, and legacy correspondence threads. Those structures are not a substitute for an independent abuse-reporting schema, even if a few mail/artifact utilities can be factored into reusable code.

### Current worktree boundary

The worktree already contains unrelated, uncommitted phishing-submission correspondence work. It must be preserved and not folded into this feature merely because some pieces are adjacent.

Observed unrelated modified files include:

- `docker-compose.yml`
- `drizzle/meta/_journal.json`
- `src/app/submissions/[id]/SubmissionPageClient.tsx`
- `src/lib/db/entities.ts`, `src/lib/db/index.ts`, and `src/lib/db/schema.ts`
- `src/lib/imap/imap_listener.ts`
- `src/lib/mail_ai.ts`
- several files under `src/lib/report/`
- `src/lib/submissions/details.ts` and `src/lib/website_ai.ts`

Observed unrelated untracked files include:

- `drizzle/0004_per_report_reply_identities.sql`
- `drizzle/meta/0004_snapshot.json`
- `src/components/ReportThreadTimeline.tsx`
- `src/lib/imap/routing.ts`
- `src/lib/report/correspondence.ts`
- `src/lib/website_url.ts`

Future work must preserve these changes, avoid reset/revert operations, and keep any new abuse-reporting migration/table ownership plainly separate.

## Target public contract

### Pages

1. `GET /abuse-reporting`
   - Native Phishing Support interface; no iframe and no exposed Skyvern UI.
   - Displays the required slogan and explains that verified reports are submitted automatically.
   - Has no case selector, login, submitter CAPTCHA, submitter email verification, or manual approval control.
   - Accepts targets, allegation category, detailed description, associated observed URLs, relevant legal brand URL, optional reporter contact/identity preference, and evidence.

2. `GET /abuse-reporting/:trackingToken`
   - Bearer-token status view.
   - Shows safe public status, normalized targets, provider-route states, confirmations/ticket IDs, and safe failures.
   - Does not disclose secrets, internal IDs, raw provider correspondence, browser/CDP information, or unrestricted database records.

### API

```text
POST /api/abuse/reports
GET  /api/abuse/reports/:trackingToken
POST /api/skyvern/webhook
```

The create endpoint uses a public JSON contract so the web page and external callers share one validated submission path:

```ts
type CreateAbuseReportRequest = {
  targets: string[];
  allegationCategory: string;
  description: string;
  observedUrls?: Array<{
    target: string;
    urls: string[];
  }>;
  legalBrandUrl?: string;
  reporterContactEmail?: string;
  reporterIdentity?: "service" | "submitter";
  evidence?: Array<{
    filename: string;
    mimeType: string;
    base64: string;
  }>;
  idempotencyKey?: string;
};

type CreateAbuseReportResponse = {
  trackingToken: string;
  status: "accepted";
  statusUrl: string;
};
```

The raw tracking token is returned once. Only its hash is stored. The server must own provider definitions, prompt construction, browser selection, form behavior, redirect destinations, and Skyvern task data. It must reject client-supplied CDP/browser configuration, provider URLs, selectors, prompts, API keys, arbitrary headers, proxies, or redirects.

### Input and evidence rules

- Normalize domains using IDNA/punycode, lowercase, and trailing-dot removal; retain original input and input order.
- Deduplicate normalized targets without discarding their source provenance.
- Accept only publicly routable IPv4/IPv6 addresses; reject loopback, private, link-local, multicast, documentation, benchmark, and other non-routable ranges.
- Accept only `http`/`https` observed URLs and bind them to submitted domains.
- Bound a report’s target count (initial design reference: at most 100).
- Decode and validate evidence by actual MIME/content, not filename extension.
- Store originals forever and produce provider-constrained derivatives separately.
- Retain the full narrative even where a provider uses a shortened derivative.

## Independent data model and lifecycle

Create a separate schema and repository layer. No foreign key or execution dependency should require an existing phishing submission.

| Table/concept | Minimum responsibility |
| --- | --- |
| `abuse_reports` | Public report, hashed tracking token, request/idempotency hashes, narrative/category, identity selection, aggregate status, verification outcome, and requester metadata. |
| `abuse_targets` | Original and normalized target, type, associated URLs, resolution state/snapshot, and target disposition. |
| `abuse_provider_routes` | One report-target-provider relationship; registry key/version, verified route/provenance, payload eligibility, and route state. |
| `abuse_provider_runs` | Immutable provider payload, payload hash, external correlation key, Skyvern run ID, attempts, confirmation data, final URL, submitted targets, and failure data. |
| `abuse_artifacts` | Content-addressed original/derived evidence, resolver evidence, MIME, provider mail, browser captures, Skyvern artifacts, and audit metadata. |
| `abuse_mail_messages` | Independent inbound/outbound correspondence and its durable raw MIME/artifact references. |
| `abuse_mail_codes` | Correlation and controlled delivery of provider verification codes. |
| `abuse_jobs` | Durable jobs, leases, retries, next attempt, and `unknown_external_state` handling. |
| `abuse_events` | Append-only audit events for every state transition and external interaction. |

### Required states

Report states:

```text
accepted
resolving
verifying
queued
running
waiting_provider
partially_submitted
submitted
insufficient_evidence
no_route
failed
needs_human
canceled
```

Route states:

```text
resolving
verified
queued
running
waiting_code
submitted
awaiting_provider_reply
escalating_to_portal
acknowledged
provider_rejected
delivery_failed
insufficient_evidence
no_route
failed
needs_human
```

Aggregation must be explicit: every resolved route remains visible in the final result. A report is `submitted` only when every routable route succeeds or is acknowledged; `partially_submitted` when success coexists with a terminal no-route/evidence/failure outcome; `no_route` when no target gets a verified route; and `insufficient_evidence` when all otherwise-routable routes fail their verification contracts.

HTTP handlers only validate, persist, and enqueue. They must not launch detached reporting promises.

## Provider resolution and routing policy

### Code-owned provider registry

Implement a versioned provider registry before any portal automation. A definition contains canonical provider identity, verified domains/origins, exact registrar IDs/handles or ASN/network identifiers, route type, fixed entry URL, semantic form contract, evidence limits, identity/CAPTCHA/code policies, extraction schema, escalation rules, version, and content hash.

Skyvern may navigate a fixed verified definition or a link validated from an explicit provider reply. It must never search the web to discover arbitrary provider portals.

### Required resolution chain

For a domain:

```text
domain RDAP explicit registrar abuse contact
  → authoritative legacy port-43 WHOIS abuse-mailbox when RDAP lacks it
  → code-owned exact registrar/provider route match
```

For an IP:

```text
IP RDAP explicit abuse contact
  → authoritative legacy port-43 WHOIS explicit abuse-mailbox when missing
  → BGP-origin ASN lookup
  → ASN RDAP explicit abuse contact
```

Only explicit abuse contacts are allowed. Technical, administrative, billing, registrant, or other non-abuse contacts are never fallback recipients.

For each IP, preserve separate provenance for allocation owner, legacy WHOIS network metadata (`netname`, description, organization), BGP origin ASN, ASN organization, and every abuse contact. Do not collapse the allocation identity and origin network identity into one provider label.

Required regression shape:

```text
154.201.78.249
  → IP RDAP has no abuse contact
  → legacy WHOIS identifies network context
  → BGP origin AS402506
  → ASN RDAP supplies abuse@tgtserver.com
```

### Generic verified-email workflow

For a verified email route without a code-owned portal automation:

1. Build and persist a canonical MIME report before SMTP delivery.
2. Attach relevant retained evidence and use a per-route opaque reply identity/correlation token.
3. Track SMTP settlement independently from the provider’s substantive response.
4. Monitor the configured IMAP mailbox continuously and classify replies into `acknowledged`, `not_monitored`, `needs_more_information`, `rejected`, `bounce`, or `ambiguous`.
5. Treat email/page text as untrusted data, never executable instructions.
6. Escalate to a generic Skyvern form only when the provider explicitly declares the inbox unmonitored and the extracted HTTPS link passes provider-domain, redirect, and SSRF validation.

No response remains `awaiting_provider_reply`; silence must not trigger arbitrary portal discovery. A bounce retries using the same external correlation key rather than creating a new unrelated report.

## First provider pilot: GNAME

### Registry match and portal definition

The first automated portal provider is GNAME at the fixed entry URL:

```text
https://www.gname.com/abuse/category/2
```

Match it through a reviewed manifest of exact registrar handles, never loose display-name matching. The reviewed set includes at least:

```text
1923 — Gname.com Pte. Ltd.
3941+ — current Gname 00x Inc variants
```

The precise production manifest must carry all currently reviewed GNAME handles and a version/content hash.

### Workflow contract

For eligible GNAME-managed domains, the adapter must:

1. Open the fixed category-2 portal URL.
2. Select category `8`, “Set up phishing and fraud site.”
3. Submit only GNAME-resolved domains and only observed URLs associated with those domains.
4. Produce a provider-specific description of no more than 1,000 characters.
5. Upload JPG/PNG screenshot derivatives only, at most 15 images and at most 2 MB each.
6. Fill the configured Phishing Support legal/service name, legal brand URL, and verified service mailbox.
7. Request and receive the provider email verification code.
8. Push that code into Skyvern, check the declaration, and click the verified final submit control automatically.
9. Extract confirmation text/ticket, final URL, submitted target list, and provider errors.
10. Permanently persist provider output and all Skyvern artifacts.

GNAME’s verification code is sent to a shared service mailbox in the initial pilot. Code waits must therefore serialize. A unique-alias mailbox design may later remove this limitation, but no plus-addressing assumption is allowed for the pilot.

### GNAME evidence contract

The service—not the public submitter—makes the GNAME declaration. It can submit only after all of these pass:

- Target is a domain with a GNAME exact-registry match.
- Associated observed URL resolves to that domain or an allowed subdomain.
- A service-owned isolated browser captures fresh usable evidence.
- Screenshots are valid and satisfy GNAME’s constraints.
- A legal brand URL comes from the request or a verified service-side brand record.
- A service-side verifier classifies the allegation as phishing/fraud at the configured minimum confidence.
- Generated description fits the 1,000-character limit.
- The configured Phishing Support identity is verified for GNAME.

Any route that fails this contract ends `insufficient_evidence`; it is not submitted. If the live form no longer matches the reviewed definition in a material way, it ends `needs_human` without clicking an unknown irreversible control.

## Skyvern and browser deployment design

### Pinned SDK/image pair

Use a matched explicit pin rather than `latest`:

```text
@skyvern/client@1.0.24
public.ecr.aws/skyvern/skyvern:v1.0.24
```

The TypeScript SDK integration is mandatory. All calls pass through one internal adapter; do not add handwritten REST calls. The selected SDK surface includes `runTask`, `getRun`, `cancelRun`, `getRunArtifacts`, `getArtifact`, `retryRunWebhook`, `sendTotpCode`, `uploadFile`, and `runSdkAction`.

Side-effectful task creation must disable SDK retrying:

```ts
await skyvern.runTask(
  {
    body: {
      prompt,
      url,
      max_steps,
      data_extraction_schema,
      webhook_url,
      totp_identifier,
    },
  },
  { maxRetries: 0 },
);
```

An ambiguous task-create response is an external-state risk. It must become `unknown_external_state` and be reconciled before any retry that could duplicate a provider submission.

### File uploads and immutable task data

1. Persist original evidence in the service artifact store forever.
2. Create constrained provider-specific derivatives.
3. Upload each derivative via `skyvern.uploadFile()`.
4. Put only the returned presigned URLs into an immutable machine-generated task payload.
5. Instruct Skyvern to use only those URLs.

Never assume an application-local file path is visible inside the Skyvern container. The compatibility spike must prove both the normal SDK upload/task path and `runSdkAction` with `ai_upload_file` against the same CDP browser before live GNAME upload is enabled.

### Internal topology

```text
Public browser/API
        ↓
Phishing Support app
  ├── independent abuse-report schema and durable queue
  ├── permanent artifact storage
  └── @skyvern/client
          ↓
     internal Skyvern API
          ↓ CDP
dedicated Chrome/Xvfb sidecar
  ├── isolated private profile
  └── DBC extension
```

Add internal-only Compose services for `skyvern-postgres`, `skyvern`, and `abuse-browser`. Configure stock Skyvern approximately as follows:

```text
BROWSER_TYPE=cdp-connect
BROWSER_REMOTE_DEBUGGING_URL=http://abuse-browser:9222/
```

Do not expose the Skyvern API/UI, CDP port, VNC, browser profile, DBC credentials, or browser-profile volume publicly. Skyvern must not attach to the normal Phishing Support browser process or a user’s browser profile.

### DBC and Patchright constraints

The dedicated browser must explicitly load the pinned Death By Captcha extension and bootstrap its credentials privately:

```text
Extension ID: ejagiilfhmflpcohicichiokfoofeljp
Manifest version: 3
Extension version: 2.0.3
SHA-256: 532c810e8eb559efd49267d33870641bdd77a41742f4f7e2b687599fc8686aeb
```

It must not use `--disable-extensions`, must prevent unnoticed extension auto-updates, and must never surface DBC configuration to the public API/UI. Existing `src/lib/browser/browser.ts` disables extensions, so it cannot be the DBC browser process without intentional redesign.

The existing application uses Patchright/Rebrowser utilities for browser work. Stock Skyvern driving a CDP Chrome browser through ordinary Playwright does **not** receive Patchright’s driver-level protocol patches. The agreed first implementation is therefore:

- Patchright may remain useful for independent evidence capture.
- Stock Skyvern uses the dedicated CDP Chrome sidecar for portal execution.
- Documentation and UI must not claim stock Skyvern has Patchright stealth.
- A custom Skyvern/Patchright image is a separate future compatibility project, not part of the GNAME pilot.

## Durable execution, webhooks, and operational safety

### Worker and recovery

The custom server lifecycle must start an abuse-specific durable worker. It atomically claims jobs, records a state transition before external work, renews leases, recovers stale leases after restarts, prevents duplicate concurrent route execution, and retains `unknown_external_state` rather than assuming a failed API response means no provider action happened.

The public status page polls the database. SSE may later be an optimization, but process-local event streams cannot be the source of truth.

### Webhook contract

`POST /api/skyvern/webhook` must read raw request bytes and validate `x-skyvern-signature` and `x-skyvern-timestamp` using HMAC-SHA256 with `SKYVERN_API_KEY` and `crypto.timingSafeEqual`. It rejects missing, malformed, mismatched, expired/replayed signatures; persists events idempotently; and returns promptly after durable persistence.

When a Skyvern run appears failed solely because its webhook delivery failed, the worker must call `getRun()` and inspect actual run output/status before classifying the provider route. Reconcile `completed`, `failed`, `terminated`, `timed_out`, and `canceled` explicitly.

### Security and retention controls

Before public enablement, implement:

- request and evidence-size limits;
- decoded image/MIME validation;
- SSRF controls for all service-side fetches and provider links;
- blocking of private networks, metadata services, and unsafe schemes;
- redirect-by-redirect revalidation;
- opaque hashed tracking tokens and signed token-authorized artifact access;
- no public report list and no target-based global lookup;
- prompt-injection-resistant treatment of webpages and emails;
- verified provider-origin allowlists and definition version/hash checks;
- emergency disable switches for provider routes;
- queue/concurrency observability without user-facing quotas;
- backups for application data and artifact/Skyvern storage, disk-capacity monitoring, and alerts for failed backups.

Retain forever the request, originals, derivatives, resolver data, correspondence, Skyvern artifacts, confirmations, and every lifecycle event. There is intentionally no retention-expiration or purge job.

## Implementation phases and completion checklist

### Phase 0 — compatibility and security spike

- [ ] Add the pinned SDK/image pair in an isolated implementation branch/worktree phase.
- [ ] Stand up internal Skyvern PostgreSQL, Skyvern, dedicated Chrome/Xvfb CDP sidecar, isolated profile, and pinned DBC extension.
- [ ] Verify SDK-to-Skyvern connectivity, CDP connection, extension presence/bootstrap, and no public exposure of internal ports/profiles.
- [ ] Prove `uploadFile()` task upload and `runSdkAction`/`ai_upload_file` against the exact CDP browser.
- [ ] Prove webhook signature validation, TOTP/code delivery, run-artifact retrieval, and safe run reconciliation.
- [ ] Use a controlled/authorized provider fixture or canary only; do not make a victim domain the first live test.

### Phase 1 — independent persistence and public submission contract

- [ ] Add standalone schema, repositories, migrations, state enums, immutable payload snapshots, content-addressed artifacts, jobs, and append-only events.
- [ ] Implement tracking-token hashing and request idempotency semantics.
- [ ] Implement `POST /api/abuse/reports` with strict target/evidence validation, safe request metadata capture, durable persistence, and enqueue-only behavior.
- [ ] Implement status API and bearer-token status page without public listing or secret leakage.
- [ ] Build the native `/abuse-reporting` form with the required slogan and accessible keyboard/error behavior.

### Phase 2 — resolver, evidence, and verified route selection

- [ ] Extract/adapt generic RDAP primitives without coupling to legacy `submissions`.
- [ ] Implement authoritative port-43 WHOIS lookup and parsing under SSRF/network controls.
- [ ] Implement IP RDAP → WHOIS → BGP origin → ASN RDAP fallback with full independent provenance.
- [ ] Implement domain RDAP/WHOIS resolution and explicit-abuse-contact filtering.
- [ ] Create a versioned provider registry with exact GNAME registrar handles and route disable switches.
- [ ] Build isolated evidence capture and provider-compatible screenshot derivatives.
- [ ] Implement the GNAME evidence contract and `insufficient_evidence` disposition.

### Phase 3 — email relay and correspondence lifecycle

- [ ] Build independent canonical MIME sender, reply identities, artifacts, outbound settlement, and route correlation.
- [ ] Extend IMAP intake through abuse-specific tables and idempotency ledgers.
- [ ] Add strict-schema AI reply classification and safe extraction of verified provider form links.
- [ ] Implement only explicit `not_monitored` escalation, safe information-response policy, bounce correlation, and no-response monitoring.

### Phase 4 — GNAME portal automation

- [ ] Implement an immutable GNAME task builder and semantic provider-form contract.
- [ ] Implement GNAME category selection, domain/URL handling, description truncation, derivative upload, service identity, declaration, code wait, automatic final submit, and confirmation extraction.
- [ ] Serialize shared-mailbox GNAME code waits.
- [ ] Persist screenshots, recordings, action history, extracted output, confirmation data, and provider errors.
- [ ] Fail closed as `needs_human` on material field/declaration/final-control/origin drift.

### Phase 5 — durable operations and rollout

- [ ] Add atomic job claim/lease renewal/recovery and crash-safe external side-effect handling.
- [ ] Add Skyvern webhook persistence/replay protection and `getRun()` reconciliation.
- [ ] Add operational metrics, storage/backup alerts, route kill switches, and safe error reporting.
- [ ] Run an authorized GNAME canary using the real service mailbox.
- [ ] Enable automatic GNAME public submissions only after the canary and regression suite pass.
- [ ] Enable generic verified-email routes and explicit reply-to-form escalation incrementally.
- [ ] Add later providers as registry definitions without changing the public submission contract.

## Required verification suite

No feature should be called complete after a smoke test. The following coverage is part of the definition of done.

### Unit tests

- Domain IDNA normalization, original-input preservation, and stable deduplication.
- Public IPv4/IPv6 validation and rejection of reserved/non-routable ranges.
- Explicit RDAP abuse extraction and exclusion of technical/admin contacts.
- Domain and IP port-43 WHOIS fallback.
- BGP origin and ASN RDAP fallback, including `154.201.78.249` → `AS402506` → `abuse@tgtserver.com` shape.
- Exact GNAME registrar-handle matching and provider definition version/hash checks.
- Description/evidence derivative limits and GNAME evidence eligibility.
- Tracking-token hash, request idempotency, MIME/reply correlation, and AI-classification schema validation.
- Provider-link allowlisting, SSRF/redirect checks, and webhook signature/timestamp/replay/idempotency validation.

### Integration tests

- Fresh migration and restart behavior.
- Atomic job claims, lease renewal, stale-lease recovery, and process crash between persistence/external calls.
- Ambiguous Skyvern task creation and `unknown_external_state` reconciliation.
- `getRun()` reconciliation after webhook failure.
- Permanent artifact retrieval/import, IMAP duplicate delivery, and UID-ledger behavior.
- Verification-code extraction and `sendTotpCode` handling, including serialized GNAME code waits.
- Verified provider-email reply escalation and rejection of malicious/off-domain links.
- Accurate no-route, insufficient-evidence, partial, and submitted aggregate status rules.

### Browser/Skyvern tests

- Pinned SDK/image compatibility and dedicated CDP connection.
- DBC extension installation/credential bootstrap and an authorized CAPTCHA-solve test.
- SDK upload plus browser file-input upload on the same CDP runtime.
- GNAME category, multi-domain rows, evidence upload, code wait, declaration, automatic final submit, and confirmation extraction.
- Permanent Skyvern screenshot/recording/action-history persistence.
- Fixture failures for renamed required fields, materially changed declaration text, missing/replaced final submit controls, and redirect to an unapproved origin. Every such fixture must reach `needs_human` without an irreversible click.

### UI/API tests

- Anonymous submission with multiple domains/IPs.
- Validation errors, invalid/oversized evidence, and idempotent resubmission.
- Valid/invalid bearer status tokens and absence of public listing.
- Partial route completion, no-route, insufficient-evidence, and worker-restart status updates.
- Accessibility and keyboard operation of the public form.

## Rollout gates

1. Complete the pinned compatibility spike and controlled fixtures.
2. Implement independent data/API/UI/worker paths behind disabled provider flags.
3. Enable resolver and evidence capture while retaining portal submission disabled.
4. Run an authorized GNAME canary with the verified service mailbox.
5. Enable automatic GNAME execution for public `/abuse-reporting` only after evidence, browser, webhook, and recovery tests pass.
6. Enable generic verified email and explicit inbox-not-monitored escalation incrementally.
7. Add further provider definitions without widening the public API or allowing arbitrary portal discovery.

## Progress conclusion

The product decisions and technical integration plan are now documented, including the necessary separation from legacy phishing submissions. Existing RDAP, SMTP, IMAP, and browser utilities provide useful implementation patterns, but none constitutes the standalone service required here.

The next implementation task should begin with the pinned Skyvern/CDP/DBC compatibility spike and the independent persistence/API foundation, while preserving the currently dirty legacy correspondence worktree unchanged.
