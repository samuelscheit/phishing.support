# Evoxt forwarding and origin-sweep research

Date: 2026-10-31

## Findings

### What the public response proves

TLS Server Name Indication (SNI) carries a hostname in the ClientHello so a TLS terminator can select a virtual server and certificate. HTTP/1.1 then uses `Host` to select the target resource. A TCP forwarding layer can relay both without owning the certificate or generating the HTTP response. [RFC 6066 §3](https://www.rfc-editor.org/rfc/rfc6066.html#section-3) defines SNI; [RFC 9110 §7.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-7.2) defines `Host`.

A `Cf-Ray` response header establishes that Cloudflare processed the HTTP request and its suffix identifies the processing data center. It does not identify the customer account, product, origin IP, or the intermediate forwarder. Cloudflare states that every request through Cloudflare receives a Ray ID and that account-side Security Events, Log Explorer, or logs can be searched by Ray ID. [Cloudflare Ray ID](https://developers.cloudflare.com/fundamentals/reference/cloudflare-ray-id/) and [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-ray).

Cloudflare documents `Edge IP Restricted` as Error 1034. The public page establishes an Edge IP Validation rejection, but its documented causes include restricted/BYOIP or dedicated address space, Cloudflare for SaaS restrictions, and an Address Map owned by a different account. The page alone cannot select one cause or reveal an account/service. [Cloudflare Error 1034](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1034/).

### Interpretation of the observed multi-host test

Observed: connections to the same Evoxt-routed destination IP, while varying end-to-end SNI and HTTP `Host`, returned certificates appropriate to several unrelated Cloudflare-served hostnames and then Cloudflare Error 1034; non-Cloudflare and non-existent names did not complete the same route.

**Inference:** this is strong evidence that the Evoxt endpoint relays Cloudflare-bound TLS traffic according to SNI (or applies an equivalent Cloudflare-only upstream-routing rule). It rules against a fixed backend and against a route configured solely for the reported phishing hostname. The per-host certificates are consistent with Cloudflare terminating TLS after the relay, because SNI is the standard mechanism by which a TLS server selects the certificate for a named virtual host. [RFC 6066 §3](https://www.rfc-editor.org/rfc/rfc6066.html#section-3).

It does **not** establish a generic Internet-wide SNI proxy: the tested non-Cloudflare names failed. It also does not identify a Cloudflare product, customer account, origin address, or the relay's second-hop destination. Error 1034 establishes only that Cloudflare's Edge IP Validation rejected the hostname/address association; Cloudflare documents several possible causes, so selecting one from the public response would be speculation.

A Cloudflare `Suspected Phishing` interstitial similarly establishes that Cloudflare handled and blocked that hostname/URL. It is not content returned by the suspected origin.

### How to distinguish the forwarding modes

Use one fixed candidate IP and keep the TCP destination constant while varying only end-to-end SNI and HTTP `Host`:

1. Probe several unrelated names with independently recognizable certificates and bodies, including at least one Cloudflare-served name and one non-Cloudflare name.
2. Probe a unique, non-existent hostname.
3. Best evidence: create a one-use hostname under a domain you control, point it at a TLS server you control, and retain authoritative DNS plus server connection logs. Use a fresh label to avoid DNS cache ambiguity.
4. Record the peer address reported by the socket when available, TLS certificate, ALPN, complete HTTP status/headers/body hash, `Cf-Ray`, timestamps, and failures.
5. Repeat each case to distinguish deterministic routing from intermittent fallback behavior.

Interpretation:

- Unrelated names reach their respective real providers: generic SNI-aware forwarding/resolution.
- Only Cloudflare-served names work: Cloudflare-specific upstream or egress policy; this is not enough to name the Cloudflare product/account.
- Only the reported domain works: configured per-domain route.
- Every SNI receives the same certificate/backend: fixed default upstream.
- A controlled hostname reaches the controlled server through the candidate IP: strong proof of a generic SNI forwarder. The authoritative DNS and server logs reveal resolver/egress behavior.
- Certificate-only matches remain candidates, never confirmed origins.

Cloudflare Workers' TCP API exposes `SocketInfo.remoteAddress` when available, while Cloudflare notes that it may be null. The same documentation states that outbound Worker TCP connections to Cloudflare IP ranges are blocked. Record `remoteAddress` in future probes, but do not treat it as evidence of the proxy's hidden second hop. [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).

### How to identify the exact Cloudflare destination or service

An external client generally cannot see a TCP proxy's second connection. Traceroute and the client-visible TCP peer stop at the forwarder; the forwarder creates a new connection with a new TTL and transport state.

Authoritative evidence, strongest first:

1. Evoxt or the service operator supplies packet capture, connection tracking/NAT state, load-balancer configuration, or outbound flow logs matching the inbound timestamp. This reveals the downstream IP and whether forwarding is dynamic or configured.
2. Cloudflare Support or the zone/account owner searches the supplied Ray IDs and exact UTC timestamps. Cloudflare documents Ray-ID lookup in Security Events, Log Explorer, and enterprise logs. Public users cannot use a Ray ID to recover the account or origin.
3. A controlled unique hostname plus authoritative DNS and controlled origin logs reveals whether the forwarder resolves arbitrary SNI and the source address of its outbound connection.
4. Multiple independent SNI probes can classify generic versus Cloudflare-specific versus per-domain behavior, but cannot reliably name an internal Cloudflare product or customer account.

Send Cloudflare the Ray IDs, UTC timestamps, hostname, exact URL, the abuse report ID, and the fact that the TCP destination was an Evoxt-routed address. Send Evoxt the same timestamps and ask for the outbound destination/flow for each inbound tuple.

## Current Evoxt announcements

RIPEstat reports both ASNs as announced and maps their abuse contact to `abuse@evoxt.com`:

- AS149440: `EVOXTSDNBHD-AS-AP - Evoxt Sdn. Bhd.`
- AS212083: `EVOXT Jerng Yue Lee trading as Evoxt Enterprise`

Primary data:

- [AS149440 overview](https://stat.ripe.net/data/as-overview/data.json?resource=AS149440)
- [AS149440 announced prefixes](https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS149440)
- [AS149440 abuse contact](https://stat.ripe.net/data/abuse-contact-finder/data.json?resource=AS149440)
- [AS212083 overview](https://stat.ripe.net/data/as-overview/data.json?resource=AS212083)
- [AS212083 announced prefixes](https://stat.ripe.net/data/announced-prefixes/data.json?resource=AS212083)
- [AS212083 abuse contact](https://stat.ripe.net/data/abuse-contact-finder/data.json?resource=AS212083)

At the RIPEstat snapshot time `2026-10-31T08:00:00Z`:

- AS149440 announced 181 IPv4 prefixes, all /24: 46,336 addresses.
- AS212083 announced one IPv4 /24: 256 addresses.
- Total IPv4 sweep scope: 182 /24 prefixes, 46,592 addresses.
- AS149440 also announced 17 IPv6 /48 prefixes; the requested IPv4 sweep does not cover them.

### AS149440 IPv4 prefixes

```text
23.26.201.0/24
23.26.204.0/24
23.26.237.0/24
23.26.251.0/24
23.27.0.0/24
23.27.11.0/24
23.27.12.0/24
23.27.13.0/24
23.27.20.0/24
23.27.22.0/24
23.27.24.0/24
23.27.25.0/24
23.27.26.0/24
23.27.28.0/24
23.27.46.0/24
23.27.47.0/24
23.27.48.0/24
23.27.49.0/24
23.27.50.0/24
23.27.51.0/24
23.27.52.0/24
23.27.53.0/24
23.27.96.0/24
23.27.97.0/24
23.27.98.0/24
23.27.99.0/24
23.27.113.0/24
23.27.119.0/24
23.27.120.0/24
23.27.121.0/24
23.27.123.0/24
23.27.124.0/24
23.27.125.0/24
23.27.126.0/24
23.27.140.0/24
23.27.141.0/24
23.27.142.0/24
23.27.143.0/24
23.27.163.0/24
23.27.164.0/24
23.27.168.0/24
23.27.169.0/24
23.27.175.0/24
23.27.176.0/24
23.27.177.0/24
23.27.186.0/24
23.27.199.0/24
23.27.200.0/24
23.27.201.0/24
23.27.202.0/24
23.27.240.0/24
23.27.244.0/24
23.27.245.0/24
23.230.239.0/24
38.95.173.0/24
38.211.230.0/24
38.225.209.0/24
38.226.20.0/24
38.246.69.0/24
38.246.70.0/24
38.246.71.0/24
38.246.72.0/24
38.246.73.0/24
45.38.248.0/24
45.134.36.0/24
45.194.27.0/24
45.195.69.0/24
45.195.76.0/24
45.249.90.0/24
50.114.5.0/24
50.114.59.0/24
50.114.113.0/24
50.114.180.0/24
87.86.23.0/24
91.218.183.0/24
96.126.130.0/24
96.126.179.0/24
96.126.190.0/24
96.126.191.0/24
103.179.142.0/24
103.179.143.0/24
108.165.64.0/24
108.165.65.0/24
108.165.100.0/24
108.165.147.0/24
108.165.155.0/24
108.165.177.0/24
108.165.183.0/24
108.165.255.0/24
108.171.40.0/24
108.171.45.0/24
136.0.0.0/24
136.0.1.0/24
136.0.3.0/24
136.0.7.0/24
136.0.8.0/24
136.0.9.0/24
136.0.10.0/24
136.0.11.0/24
136.0.110.0/24
136.0.141.0/24
136.0.159.0/24
136.0.254.0/24
142.111.15.0/24
142.111.77.0/24
142.111.135.0/24
142.111.143.0/24
142.111.146.0/24
142.111.194.0/24
144.225.112.0/24
144.225.188.0/24
151.158.0.0/24
151.158.1.0/24
154.81.220.0/24
154.91.0.0/24
155.254.60.0/24
156.225.64.0/24
156.227.0.0/24
156.235.89.0/24
156.236.76.0/24
166.0.23.0/24
166.0.106.0/24
166.0.132.0/24
166.0.150.0/24
166.0.253.0/24
166.1.249.0/24
166.88.1.0/24
166.88.2.0/24
166.88.4.0/24
166.88.6.0/24
166.88.7.0/24
166.88.8.0/24
166.88.11.0/24
166.88.14.0/24
166.88.35.0/24
166.88.54.0/24
166.88.55.0/24
166.88.57.0/24
166.88.61.0/24
166.88.73.0/24
166.88.77.0/24
166.88.78.0/24
166.88.90.0/24
166.88.95.0/24
166.88.96.0/24
166.88.97.0/24
166.88.98.0/24
166.88.99.0/24
166.88.100.0/24
166.88.101.0/24
166.88.114.0/24
166.88.117.0/24
166.88.132.0/24
166.88.134.0/24
166.88.141.0/24
166.88.167.0/24
166.88.194.0/24
166.88.198.0/24
166.88.209.0/24
168.93.198.0/24
168.93.214.0/24
172.121.5.0/24
172.252.217.0/24
185.132.54.0/24
193.57.57.0/24
193.247.144.0/24
198.20.133.0/24
198.20.153.0/24
198.105.126.0/24
198.105.127.0/24
202.61.72.0/24
202.61.73.0/24
202.61.74.0/24
202.61.75.0/24
205.186.64.0/24
205.186.67.0/24
216.173.64.0/24
216.173.65.0/24
216.173.66.0/24
216.173.67.0/24
223.165.6.0/24
```

### AS212083 IPv4 prefixes

```text
147.189.161.0/24
```

## Sweep evidence rule

A full sweep should have two stages:

1. Cheap discovery: bounded TCP/TLS handshakes and HTTP-port reachability across all 46,592 IPv4 addresses.
2. Verification: for every reachable/certificate candidate, connect to that exact IP with the reported hostname as SNI and `Host`, request both the root and exact reported path, and retain raw headers/body hashes.

Classify a candidate as a confirmed origin only when the exact-IP HTTP response contains the captured kit or a stable kit fingerprint. Cloudflare pages, CDN/security interstitials, generic default pages, certificate-only matches, timeouts, and forwarded responses are not origin confirmation.

## Completed 2026-10-31 sweep

The reproducible evidence is in
`investigation/2dayduecheck/evoxt-sweep/`. The sweep expanded the complete
RIPEstat snapshot and tested all 46,592 IPv4 addresses over both HTTP and
HTTPS, pinning each connection to the candidate address while preserving
`2dayduecheck.website` as TLS SNI and HTTP `Host`.

The verification requests used the exact reported session URL and the archived
same-host stylesheet `/res/css/style.css?v=6` (12,907 bytes; SHA-256
`86caf93e41826d4c8518cc91df16ea5f0fd2d13151a058b0a170241dcc7cdbbd`).
The session response was checked for the independently captured markers
`signin-card`, `authenticator-code`, and `backup-code`.

The comprehensive run obtained 4,052 HTTP responses and 4,814 HTTPS responses.
It found 449 addresses presenting the same domain certificate across 128
distinct `/24` prefixes, but zero addresses returned either the captured
stylesheet hash or all session-page markers over either protocol. Of those
certificate candidates, 406 returned HTTPS application responses and every
response carried both `Server: cloudflare` and `CF-Ray`. An earlier independent
resource-only pass observed 571 transient certificate candidates across 138
prefixes and the same zero content matches, demonstrating that relay endpoint
availability changes between scans without changing the content conclusion.

This result found no Evoxt address serving the captured phishing kit. The
distribution of one identical certificate across hundreds of addresses and
most of the announced prefixes is empirical evidence for a broadly deployed
Cloudflare-bound relay behavior, not 571 independent origins. It still does
not identify the relay operator, Cloudflare product/account, hidden second
hop, or the attacker's origin outside the swept ranges.
