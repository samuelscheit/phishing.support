import crypto from "node:crypto";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import { getDomain, parse } from "tldts";

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

export function sha256Hex(value: string | Buffer): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON is used for immutable request/run hashes and never for display. */
function stableJsonValue(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		// JSON.stringify turns non-finite numbers into null. Preserve that
		// familiar JSON behavior while still producing a valid canonical value.
		return Number.isFinite(value) ? JSON.stringify(value) : "null";
	}
	if (typeof value === "bigint") return JSON.stringify(value.toString());
	if (typeof value !== "object") throw new TypeError(`Cannot create stable JSON for ${typeof value}.`);
	if (Array.isArray(value)) return `[${value.map((item) => stableJsonValue(item) ?? "null").join(",")}]`;
	if (value instanceof Date) return JSON.stringify(value.toJSON());
	if (Buffer.isBuffer(value)) return JSON.stringify(value.toString("base64"));
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.flatMap((key) => {
			const encoded = stableJsonValue(record[key]);
			// Match JSON.stringify: object properties whose value is undefined are
			// omitted rather than emitting the invalid token `undefined`.
			return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
		});
	return `{${entries.join(",")}}`;
}

export function stableJson(value: unknown): string {
	return stableJsonValue(value) ?? "null";
}

export function hashStableJson(value: unknown): string {
	return sha256Hex(stableJson(value));
}

export function createTrackingToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

/**
 * Idempotent requests need a reproducible response without retaining a raw
 * bearer token. A deployment-owned HMAC key produces the same opaque token for
 * the same idempotency key and immutable payload, but it is never persisted.
 */
export function createIdempotentTrackingToken(idempotencyKey: string, payloadHash: string): string {
	const secret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
	if (!secret || Buffer.byteLength(secret) < 32) {
		throw new Error("ABUSE_TRACKING_TOKEN_SECRET must be configured with at least 32 bytes when idempotency keys are accepted.");
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

function parseIpv4Bytes(value: string): Buffer | undefined {
	const parts = value.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
	const bytes = parts.map(Number);
	if (bytes.some((part) => part < 0 || part > 255)) return undefined;
	return Buffer.from(bytes);
}

function parseIpv6Bytes(value: string): Buffer | undefined {
	if (value.includes("%") || isIP(value) !== 6) return undefined;
	let source = value.toLowerCase();
	if (source.includes(".")) {
		const separator = source.lastIndexOf(":");
		if (separator === -1) return undefined;
		const ipv4 = parseIpv4Bytes(source.slice(separator + 1));
		if (!ipv4) return undefined;
		const high = ipv4.readUInt16BE(0).toString(16);
		const low = ipv4.readUInt16BE(2).toString(16);
		source = `${source.slice(0, separator)}:${high}:${low}`;
	}

	const doubleColon = source.indexOf("::");
	if (doubleColon !== -1 && source.indexOf("::", doubleColon + 1) !== -1) return undefined;
	const head = doubleColon === -1 ? source.split(":") : source.slice(0, doubleColon).split(":").filter(Boolean);
	const tail = doubleColon === -1 ? [] : source.slice(doubleColon + 2).split(":").filter(Boolean);
	if (head.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || tail.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
	const zeros = 8 - head.length - tail.length;
	if ((doubleColon === -1 && zeros !== 0) || (doubleColon !== -1 && zeros < 1)) return undefined;
	const groups = [...head, ...Array(zeros).fill("0"), ...tail];
	if (groups.length !== 8) return undefined;
	const bytes = Buffer.alloc(16);
	groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
	return bytes;
}

function ipBytes(value: string): Buffer | undefined {
	return isIP(value) === 4 ? parseIpv4Bytes(value) : parseIpv6Bytes(value);
}

function isInCidr(value: string, base: string, prefixLength: number): boolean {
	const target = ipBytes(value);
	const network = ipBytes(base);
	if (!target || !network || target.byteLength !== network.byteLength) return false;
	let remaining = prefixLength;
	for (let index = 0; index < target.byteLength; index++) {
		if (remaining <= 0) return true;
		const width = Math.min(8, remaining);
		const mask = (0xff << (8 - width)) & 0xff;
		if ((target[index] & mask) !== (network[index] & mask)) return false;
		remaining -= width;
	}
	return true;
}

const NON_PUBLIC_IPV4: Array<[string, number]> = [
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
	const version = isIP(value);
	// Node accepts IPv6 zone identifiers in `isIP()`, but those are scoped
	// local interface addresses, not portable public targets.  Requiring our
	// byte parser to succeed also makes every CIDR comparison fail closed.
	if (!version || !ipBytes(value)) return false;
	const blocked = version === 4 ? NON_PUBLIC_IPV4 : NON_PUBLIC_IPV6;
	if (blocked.some(([base, prefix]) => isInCidr(value, base, prefix))) return false;
	// IPv6 global-unicast space is 2000::/3. Anything outside it is local,
	// multicast, experimental, or otherwise not a public Internet destination.
	return version === 4 || isInCidr(value, "2000::", 3);
}

export function isSafePublicHostname(value: string): boolean {
	if (isIP(value)) return isPublicIp(value);
	return Boolean(normalizeDomain(value));
}

export function registrableDomain(value: string): string | undefined {
	return getDomain(value, { allowPrivateDomains: false }) ?? undefined;
}

export function domainMatchesOrIsSubdomain(hostname: string, targetDomain: string): boolean {
	const host = normalizeDomain(hostname);
	const target = normalizeDomain(targetDomain);
	return Boolean(host && target && (host === target || host.endsWith(`.${target}`)));
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

export function safePublicError(status: string, detail?: string | null): string | undefined {
	if (!detail) return undefined;
	if (status === "needs_human") return "The provider form changed in a way that prevented a safe automatic submission.";
	if (status === "insufficient_evidence") return "The stored evidence did not satisfy this provider's verification requirements.";
	if (status === "no_route") return "No verified abuse-reporting route was available for this target.";
	if (status === "delivery_failed") return "The provider report could not be delivered.";
	if (status === "failed" || status === "unknown_external_state") return "The provider route did not complete safely.";
	return undefined;
}

const ARTIFACT_TOKEN_TTL_SECONDS = 10 * 60;

export function createArtifactAccessToken(artifactId: bigint, trackingTokenHash: string, expiresAt = Math.floor(Date.now() / 1000) + ARTIFACT_TOKEN_TTL_SECONDS): string {
	const secret = process.env.ABUSE_ARTIFACT_TOKEN_SECRET;
	if (!secret || Buffer.byteLength(secret) < 32) throw new Error("ABUSE_ARTIFACT_TOKEN_SECRET must be configured with at least 32 bytes.");
	const payload = `${artifactId.toString()}.${expiresAt}.${trackingTokenHash}`;
	const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
	return `${artifactId.toString()}.${expiresAt}.${signature}`;
}

export function verifyArtifactAccessToken(token: string, artifactId: bigint, trackingTokenHash: string): boolean {
	const secret = process.env.ABUSE_ARTIFACT_TOKEN_SECRET;
	if (!secret || Buffer.byteLength(secret) < 32) return false;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== artifactId.toString() || !/^\d+$/.test(parts[1])) return false;
	const expiresAt = Number(parts[1]);
	if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
	const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}.${trackingTokenHash}`).digest();
	let received: Buffer;
	try {
		received = Buffer.from(parts[2], "base64url");
	} catch {
		return false;
	}
	return received.byteLength === expected.byteLength && crypto.timingSafeEqual(received, expected);
}
