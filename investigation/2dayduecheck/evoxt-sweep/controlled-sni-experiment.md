# Controlled non-Cloudflare SNI experiment

Date: 2026-10-31 12:53–12:55 UTC

## Question

Do the Evoxt relay candidates forward arbitrary Internet TLS SNI, or do they
route only toward Cloudflare?

## Controlled endpoint

`respond5.tail8471cc.ts.net` was exposed temporarily through Tailscale Funnel,
not Cloudflare. Funnel terminated publicly trusted TLS and forwarded HTTP to a
logger controlled on `respond5` at `127.0.0.1:8443`.

The endpoint returned:

- Body: `controlled-non-cloudflare-origin-75101a978a6de140`
- Header: `X-Control-Token: 75101a978a6de140`
- Body SHA-256:
  `856ce49e56a2679933a3cc7470c0232157f0d203943276c58143a6272b0fab74`

A direct HTTPS request returned HTTP 200 with the token and hash. The controlled
logger recorded its unique `/control-direct-75101a978a6de140` path, proving the
endpoint and logging path worked before relay testing.

## Relay sample

Fourteen responsive Evoxt addresses were selected from fourteen different
`/24` prefixes in the comprehensive sweep:

```text
23.27.53.150
103.179.142.21
108.165.100.48
108.165.147.103
108.165.155.139
108.165.177.171
108.165.255.78
108.171.45.101
136.0.3.104
136.0.10.14
136.0.11.123
136.0.110.253
142.111.135.5
166.88.90.171
```

The independent Cloudflare Worker tunnel pinned TCP to each address while
preserving the chosen hostname as TLS SNI and HTTP `Host`.

## Results

### Non-Cloudflare control before the paired check

Two requests per address (28 total) used
`respond5.tail8471cc.ts.net`. All 28 TLS handshakes failed with TLS alert 40
(`handshake failure`). There were zero HTTP responses, zero matching body
hashes, and zero controlled-origin requests.

Raw evidence: `controlled-non-cloudflare-before.jsonl`.

### Same-address Cloudflare positive control

Immediately afterward, one request per address used `2dayduecheck.website` and
the exact reported session path. All 14 requests completed and returned HTTP
403 from Cloudflare. Every response contained `Server: cloudflare`, a unique
`CF-Ray`, Cloudflare's certificate for `2dayduecheck.website`, and either the
`Suspected Phishing` or `Edge IP Restricted` page.

Raw evidence: `cloudflare-paired-control.jsonl`.

### Non-Cloudflare control after the positive control

One more request per address immediately switched SNI and `Host` back to
`respond5.tail8471cc.ts.net`. All 14 again failed during TLS with alert 40.
There were zero HTTP responses and zero controlled-origin requests.

Raw evidence: `controlled-non-cloudflare-after.jsonl`.

The controlled logger recorded only the direct validation request and a
Tailscale health-check `HEAD /`; it recorded none of the unique Evoxt relay
paths.

## Conclusion

The same 14 Evoxt addresses were live and successfully reached Cloudflare for
the phishing hostname while consistently rejecting a live, publicly trusted,
non-Cloudflare hostname before and after that positive control. This rules out
a generic Internet-wide SNI forwarder for the tested sample.

The supported classification is **Cloudflare-specific SNI forwarding or an
equivalent Cloudflare-only routing policy**. The experiment cannot identify
the software, operator, Cloudflare product/account, internal destination
selection, or hidden origin.

## Cleanup

After evidence collection:

- Tailscale Funnel on `respond5:443` was reset; its status is `{}`.
- The controlled HTTP logger was stopped and port 8443 no longer listens.
- The public Funnel URL no longer accepts connections.
- The earlier temporary Cloudflare DNS record, direct TLS listener, certificate,
  key, and TCP/443 firewall rules had already been removed.

The user's one-time tailnet-level permission allowing Funnel remains enabled;
there is no active Funnel exposure on the node.
