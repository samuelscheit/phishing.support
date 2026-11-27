import crypto from "node:crypto";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import ipaddr from "ipaddr.js";
import { getDomain, parse } from "tldts";
import { sha256Hex } from "../../util/hash";
import { snippet } from "../../util/text";

/** A user-visible input failure that routes can safely return as a 4xx response. */
export class AbuseInputError extends Error {
	constructor(
		message: string,
		public readonly status: 400 | 413 = 400,
	) {
		super(message);
		this.name = "AbuseInputError";
	}
}

export function createTrackingToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

/**
 * A public API retry with the same idempotency key must receive the same
 * tracking token, which is only stored as a hash. A deployment-owned HMAC key
 * reproduces it from the key and the immutable payload. Submission reports
 * never use this: their submission is the idempotency guard.
 */
export function createIdempotentTrackingToken(idempotencyKey: string, payloadHash: string): string {
	const secret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
	if (!secret || Buffer.byteLength(secret) < 32) {
		throw new Error("ABUSE_TRACKING_TOKEN_SECRET must be configured with at least 32 bytes to accept idempotency keys.");
	}
	return crypto.createHmac("sha256", secret).update("abuse-tracking-token\0").update(idempotencyKey).update("\0").update(payloadHash).digest("base64url");
}

export function hashTrackingToken(token: string): string {
	return sha256Hex(token);
}

export function isTrackingToken(value: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function normalizeDomain(value: string): string | undefined {
	const trimmed = value.trim().replace(/\.+$/, "");
	if (!trimmed || trimmed.length > 253 || /[\u0000-\u001F\u007F\s/@/:\\]/.test(trimmed)) return undefined;
	const ascii = domainToASCII(trimmed);
	if (!ascii || ascii.length > 253) return undefined;
	const domain = ascii.toLowerCase();
	if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) return undefined;
	const parsed = parse(domain, { allowPrivateDomains: false });
	return parsed.isIcann && parsed.domain ? domain : undefined;
}

/**
 * A literal IP address as ipaddr.js parses it, or undefined. Node's `isIP`
 * decides what is a literal (strict dotted decimal without leading zeros,
 * so ipaddr.js never reads one as octal); a zone identifier names a local
 * interface, not a portable public target, and fails closed.
 */
function parseIp(value: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
	if (value.includes("%")) return undefined;
	const version = isIP(value);
	if (version === 4) return ipaddr.IPv4.isValidFourPartDecimal(value) ? ipaddr.IPv4.parse(value) : undefined;
	return version === 6 && ipaddr.IPv6.isValid(value) ? ipaddr.IPv6.parse(value) : undefined;
}

export const NON_PUBLIC_IPV4: ReadonlyArray<readonly [string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.31.196.0", 24],
	["192.52.193.0", 24],
	["192.88.99.0", 24],
	["192.175.48.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
	["255.255.255.255", 32],
];

const NON_PUBLIC_IPV6: Array<[string, number]> = [
	["::", 128],
	["::1", 128],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["100:0:0:1::", 64],
	// IANA reserves this protocol-assignment block for non-general-purpose
	// uses (including Teredo, benchmarking, ORCHID, AMT, and AS112). Keeping
	// the parent block here prevents a newly-added child allocation from being
	// accidentally accepted until this list is reviewed again.
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["2620:4f:8000::", 48],
	["3fff::", 20],
	["5f00::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
];

/** Reject local, special-use, documentation, benchmark, and unroutable addresses. */
export function isPublicIp(value: string): boolean {
	const address = parseIp(value);
	if (!address) return false;
	if (address instanceof ipaddr.IPv4) return !NON_PUBLIC_IPV4.some(([base, prefix]) => address.match(ipaddr.IPv4.parse(base), prefix));
	if (NON_PUBLIC_IPV6.some(([base, prefix]) => address.match(ipaddr.IPv6.parse(base), prefix))) return false;
	// IPv6 global-unicast space is 2000::/3. Anything outside it is local,
	// multicast, experimental, or otherwise not a public Internet destination.
	return address.match(ipaddr.IPv6.parse("2000::"), 3);
}

/**
 * Canonical public host: a public DNS domain or a public routable IP address.
 * URL hostnames wrap IPv6 in brackets; the WHATWG parser also compresses it,
 * so every spelling of one address yields the same target.
 */
export function normalizePublicHost(value: string): string | undefined {
	const host = value.trim().replace(/^\[(.*)\]$/, "$1");
	if (!isIP(host)) return normalizeDomain(host);
	if (!isPublicIp(host)) return undefined;
	return isIP(host) === 6 ? new URL(`http://[${host}]/`).hostname.slice(1, -1) : host;
}

/** Normalize an HTTP(S) URL without credentials whose host is public; its fragment is dropped. */
export function normalizePublicHttpUrl(value: string, options: { domainOnly?: boolean } = {}): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
	const host = options.domainOnly ? normalizeDomain(url.hostname) : normalizePublicHost(url.hostname);
	if (!host) return undefined;
	if (!isIP(host)) url.hostname = host;
	url.hash = "";
	return url.toString();
}

export function registrableDomain(value: string): string | undefined {
	return getDomain(value, { allowPrivateDomains: false }) ?? undefined;
}

export function domainMatchesOrIsSubdomain(hostname: string, targetDomain: string): boolean {
	const host = normalizeDomain(hostname);
	const target = normalizeDomain(targetDomain);
	return Boolean(host && target && (host === target || host.endsWith(`.${target}`)));
}

/** A host belongs to a domain target or its subdomains, and only to the exact address of an IP target. */
export function hostBelongsToTarget(hostname: string, target: string): boolean {
	const host = normalizePublicHost(hostname);
	const normalizedTarget = normalizePublicHost(target);
	if (!host || !normalizedTarget) return false;
	return isIP(normalizedTarget) ? host === normalizedTarget : domainMatchesOrIsSubdomain(host, normalizedTarget);
}

/** Resolve every hostname candidate before a service-side network operation. */
export async function assertPublicDnsHost(hostname: string, lookup: typeof dns.lookup = dns.lookup): Promise<void> {
	if (isIP(hostname)) {
		if (!isPublicIp(hostname)) throw new AbuseInputError("The destination resolves to a non-public network address.");
		return;
	}
	if (!normalizeDomain(hostname)) throw new AbuseInputError("The destination hostname is not a public DNS name.");
	const records = await lookup(hostname, { all: true, verbatim: true });
	if (records.length === 0 || records.some((record) => !isPublicIp(record.address))) {
		throw new AbuseInputError("The destination resolves to a non-public network address.");
	}
}

const ACRONYMS: Record<string, string> = { url: "URL", png: "PNG", dsa: "DSA", mib: "MiB", id: "ID" };

/**
 * A provider's refusal code as a sentence: `tucows_requires_a_brand_domain`
 * from the route of provider `tucows`, named Tucows, reads "Tucows requires a
 * brand domain." Text that is not a code is shown as it is.
 */
export function refusalSentence(code: string, provider?: { key: string | null; name: string }): string {
	if (!/^[a-z0-9_]+$/.test(code)) return snippet(code, 500);
	const own = provider?.key && code.startsWith(`${provider.key}_`);
	const words = (own ? code.slice(provider.key!.length + 1) : code).split("_").map((word) => ACRONYMS[word] ?? word);
	const sentence = own ? `${provider.name} ${words.join(" ")}` : words.join(" ");
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * A route's failure as the case page and status API show it. A refusal before
 * sending is our own fixed code and says what the provider's form requires; a
 * parked or failed route's detail is free provider or error text and stays internal.
 */
export function safePublicError(status: string, detail?: string | null, provider?: { key: string | null; name: string }): string | undefined {
	if (!detail) return undefined;
	// Every needs_human route settles before anything reaches the provider:
	// a provider's form or definition changed, its login or payload needs a
	// look. The detail stays internal; the public text says what is certain.
	if (status === "needs_human") return "The automatic submission stopped before anything was sent to this provider; it needs a person to finish it.";
	if (status === "insufficient_evidence") return refusalSentence(detail, provider);
	if (status === "no_route") return "No verified abuse-reporting route was available for this target.";
	if (status === "delivery_failed") return "The provider report could not be delivered.";
	if (status === "failed" || status === "unknown_external_state") return "The provider route did not complete safely.";
	// A provider's own rejection text is its public answer to our report.
	if (status === "provider_rejected") return snippet(detail, 500);
	return undefined;
}
