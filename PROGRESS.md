# Standalone abuse-reporting service — progress

**Status date:** 2026-08-14
**Overall status:** Implemented and validated as a standalone service. The rollout gates for external provider automation remain disabled until the explicitly listed operational proofs are performed by an authorized operator.

The authoritative requirements are in the specification attached to this task. The implementation keeps a hard boundary from the existing phishing-submission flow: it does not create, select, or reuse legacy submissions, cases, analysis runs, or legacy website-report records, and it does not call `createWebsiteSubmission()`.

## Delivered

- Native public UI at `/abuse-reporting` and bearer-token status UI at `/abuse-reporting/:trackingToken`; no iframe or exposed Skyvern UI.
- Public APIs:
  - `POST /api/abuse/reports`
  - `GET /api/abuse/reports/:trackingToken`
  - signed artifact access under `/api/abuse/artifacts/:id`
  - verified `POST /api/skyvern/webhook`
- Independent `abuse_*` SQLite schema and migration, repository, append-only audit events, durable jobs, leases, locks, immutable artifacts, correspondence, verification-code correlation, and provider-run records. There are no foreign keys or execution dependencies from this service into legacy submission/case/analysis/report tables.
- Strict public-input validation and security controls: IDNA/lowercase/trailing-dot normalization, original-input provenance and deterministic deduplication, public IPv4/IPv6 enforcement, bounded decoded image evidence validation, hashed tracking tokens, deterministic idempotency tokens, SSRF/DNS checks (including the configured service-verifier endpoint), signed artifact authorization, and rejection of client-controlled browser/CDP/Skyvern/provider/redirect/proxy/selector/credential fields.
- Resolver fallback chain and provenance snapshots for RDAP, authoritative port-43 WHOIS, and BGP/ASN RDAP, with abuse-contact-only extraction.
- Durable worker lifecycle integrated with the custom server, including restart-safe leases, retry handling, ambiguous external state, SMTP/IMAP intake, strict reply classification, bounce settlement, explicit-link escalation, serialized shared-mailbox code handling, and permanent correspondence/artifact retention.
- Generic verified-email delivery builds a provider-facing, recipient-specific draft instead of copying the stored analysis: the first versioned draft is durably pinned, bounded AI evidence summaries are optional and fail closed, and safe retries reuse the exact draft.
- Code-owned provider registry with exact GNAME registrar-ID matching, pinned provider-definition hashes, fail-closed output contracts, final-origin/target checks, declaration checks, and provider-specific evidence derivatives.
- Skyvern adapter with SDK-derived request types, no retries on side-effectful calls, bounded in-memory uploads with metadata, exact `ai_upload_file` payloads, response-envelope normalization, storage URL hardening, webhook verification, immutable task snapshots, reconciliation, and permanent artifact import.
- Browser Fabric-only browser boundary: Fabric owns Chromium, profile/volume affinity, egress, Turnstile handling, and CDP capability issuance. The private `fabric-cdp-relay` sidecar gives local CDP clients only opaque session routes; it is not a browser or public proxy.
- Local Skyvern/Postgres/MinIO remains as the dynamic provider-task companion. It receives a Fabric relay route per task and owns no Chromium, egress, profile, capability, or browser listener.

## Rollout gates and defaults

- Generic verified-email reporting is disabled by default (`ABUSE_GENERIC_EMAIL_ENABLED` must be explicitly enabled).
- Generic provider-form escalation is disabled by default (`ABUSE_GENERIC_FORM_ESCALATION_ENABLED` must be explicitly enabled).
- GNAME automation is disabled by default (`ABUSE_GNAME_ENABLED` and verified service identity are required).
- The generic-form policy does not permit arbitrary uploads; only code-owned provider definitions may select bounded evidence derivatives.
- No authorized GNAME canary or live production submission was performed for this task.
- No live GNAME TOTP proof was performed.
- No production Fabric/Skyvern compatibility proof or SDK upload/browser file-input compatibility proof was performed.
- The old local Chrome/Xvfb/DBC topology was removed. Fabric's reviewed recipe, managed browser runtime, egress policy, and process-level Turnstile guardian are now the only browser implementation; a production acceptance run still requires an authorized operator.

## Data-retention and operations

- Original evidence, provider-specific derivatives, browser captures, HTML/MHTML/redirect/DNS/RDAP/WHOIS evidence, outbound/inbound MIME, attachments, Skyvern screenshots/recordings/action history, and extracted output are retained indefinitely; no cleanup job expires them.
- SQLite, MinIO, and Skyvern storage require production backups, disk-growth monitoring, and alerting on failed backups before an external rollout.
- External provider operations must remain fail-closed when a route definition, output contract, origin, declaration, target set, code correlation, or form contract drifts.

## Validation

The final validation results are recorded here after the last rerun:

```text
The Fabric migration validation is run from the current checkout before each
release. It includes focused Fabric/Skyvern lifecycle tests, the full TypeScript
type checks, the full unit suite, image build, and an interpolated Compose
configuration check with test-only Fabric certificates and identifiers.
```

The Compose topology is syntax-validated only; it is not started by CI. No live
provider submission, real mail delivery, live CAPTCHA solve, live TOTP proof,
or Fabric/Skyvern compatibility proof is represented by these checks.
