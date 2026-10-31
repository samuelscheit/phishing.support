# Cloudflare origin probe

This diagnostic Worker provides an authenticated raw TCP tunnel to IPv4
addresses on port 443. The local probe performs TLS through that tunnel, so its
chosen server name (SNI) and subsequent HTTP `Host` header reach the selected
address unchanged.

It is intentionally constrained:

- any canonical IPv4 address is accepted without a deployment-time allowlist;
- the destination port is always 443;
- every tunnel requires the `PROBE_TOKEN` secret;
- only binary WebSocket frames are relayed.

Install, test, and deploy it from this directory. Supply `PROBE_TOKEN` through a
Cloudflare secrets file when creating or rotating the deployment; never put it
in `cloudflare.config.ts`:

```sh
bun install
bun run test
bun run deploy:check
cf deploy --secrets-file /path/to/secrets.json
```

The deployed `origin-probe293` token is stored in the local macOS Keychain under
account `phishing.support`. Run one probe without placing it on the command
line:

```sh
ORIGIN_PROBE_WORKER_URL=https://origin-probe293.flam3rboy.workers.dev \
ORIGIN_PROBE_TOKEN="$(security find-generic-password -a phishing.support -s origin-probe293 -w)" \
node tools/cloudflare-origin-probe/probe.mjs \
  --domain suspicious.example \
  --ip 192.0.2.1 \
  --path /
```

The JSON result includes the HTTP status, response hash and preview, phishing
markers, and the certificate observed during the end-to-end TLS connection.
