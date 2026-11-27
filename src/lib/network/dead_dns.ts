import { isIP } from "node:net";

import { fetchJson } from "./bounded_fetch";
import { errorChain } from "../util/error_chain";
import { errorText } from "../util/error_text";
import { asRecord } from "../util/values";
import { type FetchLike } from "../http/fetch";

/**
 * Telling a dead host from a broken route. A browser that leaves through a
 * proxy (Tor, an exit node) reports a host its exit cannot resolve as a
 * failed tunnel, exactly like a proxy that is down. Only a public resolver
 * answering NXDOMAIN says the name itself is gone.
 */

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5_000;
/** RFC 1035 RCODEs, as DNS-over-HTTPS JSON reports them in `Status`. */
const NOERROR = 0;
const SERVFAIL = 2;
const NXDOMAIN = 3;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/;
/** Non-public / special-use names public DNS answers NXDOMAIN for by design. */
const SPECIAL_USE_NAME = /(?:^|\.)(?:onion|i2p|local|internal|localhost|home\.arpa)$/i;

/** Whether a navigation failed because the egress proxy or resolver could not resolve the host (`ERR_TUNNEL_CONNECTION_FAILED` or `ERR_NAME_NOT_RESOLVED`). */
export function isTunnelConnectionFailure(errorOrReason: unknown): boolean {
	return [errorOrReason, ...errorChain(errorOrReason)].some((entry) => /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/.test(errorText(entry)));
}

export type NxdomainOptions = { fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number };

/**
 * Whether public DNS-over-HTTPS definitively says `hostname` does not exist:
 * an NXDOMAIN answer for its A or AAAA query, and neither query answered
 * NOERROR or SERVFAIL. A timeout, SERVFAIL, refusal, unreadable answer,
 * special-use TLD (.onion, .local, …), or IP literal is never a confirmation.
 * An abort of `signal` rejects with its reason.
 */
export async function confirmHostNxdomain(hostname: string, options: NxdomainOptions = {}): Promise<boolean> {
	options.signal?.throwIfAborted();
	const name = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
	if (isIP(name) || !HOSTNAME.test(name) || SPECIAL_USE_NAME.test(name)) return false;
	const { signal } = options;
	const base = options.fetch ?? globalThis.fetch;
	const fetch: FetchLike = signal
		? (input, init) => base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
		: base;
	const statuses = await Promise.all((["A", "AAAA"] as const).map((type) => fetchJson<unknown>(
		`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`,
		{ method: "GET", headers: { accept: "application/dns-json" } },
		{ fetch, timeoutMs: options.timeoutMs ?? DOH_TIMEOUT_MS, attempts: 1 },
	).then((answer) => asRecord(answer)?.Status, () => undefined)));
	signal?.throwIfAborted();
	return statuses.includes(NXDOMAIN) && !statuses.includes(NOERROR) && !statuses.includes(SERVFAIL);
}
