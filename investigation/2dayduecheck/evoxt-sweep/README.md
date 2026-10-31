# Evoxt IPv4 sweep evidence

This directory contains the reproducible inputs and outputs for the 2026-10-31
sweep of IPv4 prefixes announced by Evoxt AS149440 and AS212083 for the
`2dayduecheck.website` investigation.

An open port or a matching TLS certificate is only a candidate. An address is
classified as an origin only if an HTTP request pinned to that address, with
`2dayduecheck.website` as TLS SNI and HTTP `Host`, returns content matching the
captured phishing kit. Cloudflare errors and security interstitials are
forwarded/CDN responses, not origin confirmation.

## Result

`sweep.mjs` expanded all 182 recorded `/24` prefixes and tested all 46,592
addresses over HTTP and HTTPS. It requested both the exact reported session URL
and the archived same-host stylesheet `/res/css/style.css?v=6`, whose 12,907
captured bytes have SHA-256
`86caf93e41826d4c8518cc91df16ea5f0fd2d13151a058b0a170241dcc7cdbbd`.
The session response was checked for three independently captured kit markers:
`signin-card`, `authenticator-code`, and `backup-code`.

The completed `results.jsonl` summary records:

- 4,052 HTTP responses and 4,814 HTTPS responses.
- 449 addresses presenting the one identical `2dayduecheck.website`
  certificate, distributed across 128 of the 182 `/24` prefixes.
- 406 certificate candidates returning an HTTPS response; every one identified
  Cloudflare through `Server: cloudflare` and a `CF-Ray` header.
- Zero exact stylesheet matches and zero session-page kit-marker matches over
  either HTTP or HTTPS.

The three candidate requests that returned HTTP 200 still returned Cloudflare
content: the same 16,318-byte body with SHA-256
`fb240125f8d5ffe6964b7970c8647e70fac1794371b3b00833bc6a19901cb987`,
not the captured stylesheet. A focused request for the reported session URL
through `166.0.132.120` returned Cloudflare's `Suspected Phishing` page.

Conclusion: this exhaustive snapshot found no Evoxt address serving the
captured kit. The broad, identical certificate behavior is consistent with a
distributed Cloudflare-bound SNI relay and invalidates certificate-only origin
attribution.

The subsequent controlled-hostname experiment made that classification
stronger. Fourteen live relay addresses across fourteen prefixes returned
Cloudflare responses for `2dayduecheck.website`, but rejected a publicly
trusted, controlled Tailscale Funnel hostname before and after the Cloudflare
positive control. The controlled origin received no relayed request. See
`controlled-sni-experiment.md` and its three JSONL files.

## Files

- `as149440-prefixes.json`, `as212083-prefixes.json`: RIPEstat source snapshots.
- `ipv4-prefixes.txt`: deterministic IPv4 scan input.
- `captured-website.mhtml`: archived evidence from submission
  `374702847402447549`, used to derive the stylesheet fingerprint.
- `sweep.mjs`: bounded scanner; prints only certificate/content candidates and
  a final accounting record.
- `results.jsonl`: immutable output from the complete resource-and-session run.
- `resource-only-results.jsonl`: an earlier independent pass. It observed 571
  transient certificate candidates across 138 prefixes and the same zero
  content matches; the difference quantifies the relay endpoints' instability.
- `controlled-sni-experiment.md`: controlled endpoint design, paired controls,
  interpretation, limits, and cleanup.
- `controlled-non-cloudflare-before.jsonl`: two non-Cloudflare attempts through
  each of fourteen Evoxt relay addresses.
- `cloudflare-paired-control.jsonl`: successful Cloudflare positive control
  through the same fourteen addresses.
- `controlled-non-cloudflare-after.jsonl`: final non-Cloudflare attempt through
  each address immediately after its positive control.
