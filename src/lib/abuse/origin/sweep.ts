import { createHash, X509Certificate } from "node:crypto";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import tls from "node:tls";

import ipaddr from "ipaddr.js";

import { NON_PUBLIC_IPV4 } from "../security";

/** The largest IPv4 address space one host may be swept across. */
export const MAX_SWEEP_ADDRESSES = 4_000_000;
/** Addresses one job sweeps before handing the rest to a successor job. */
export const SWEEP_SLICE_ADDRESSES = 65_536;
export const MAX_ORIGIN_RESULTS = 16;
const DEFAULT_CONCURRENCY = 256;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_500;

/** What a server presented when asked for a domain by name. */
export type PresentedCertificate = {
	/** Subject and SAN DNS names, lower case. */
	names: string[];
	notBefore: string;
	notAfter: string;
	issuer: string;
	fingerprint256: string;
};

export type OriginServer = {
	ip: string;
	certificate: PresentedCertificate;
};

export type OriginSweepPrefix = { asn: number; prefix: string };
export type OriginSweepRange = OriginSweepPrefix & { start: number; end: number };
export type OriginSweepPlan = {
	ranges: OriginSweepRange[];
	addressCount: number;
	selectedPrefixes: OriginSweepPrefix[];
	totalAddresses: number;
	truncated: boolean;
};

export type TlsProbe = (ip: string, serverName: string, timeoutMs: number) => Promise<PresentedCertificate | undefined>;
export type OriginVerificationTarget = { path: string; sha256: string };
export type OriginVerifier = (
	ip: string,
	domain: string,
	targets: readonly OriginVerificationTarget[],
	timeoutMs: number,
) => Promise<boolean>;

const MAX_VERIFICATION_BODY_BYTES = 2 * 1024 * 1024;

export function capturedKitResponseMatches(
	statusCode: number | undefined,
	headers: IncomingHttpHeaders,
	bodySha256: string,
	expectedSha256: string,
): boolean {
	const server = Array.isArray(headers.server) ? headers.server.join(" ") : headers.server;
	return statusCode === 200
		&& !headers["cf-ray"]
		&& !server?.toLowerCase().includes("cloudflare")
		&& bodySha256 === expectedSha256;
}

/**
 * Prove that an address serves captured kit bytes, rather than merely relaying
 * the domain's TLS handshake. CDN responses are excluded even if they happen
 * to retain a cached copy: they do not establish the disclosed host as origin.
 */
export const servesCapturedKit: OriginVerifier = async (ip, domain, targets, timeoutMs) => {
	for (const target of targets) {
		const matched = await new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				request.destroy();
				resolve(value);
			};
			const request = https.request({
				host: ip,
				port: 443,
				servername: domain,
				path: target.path,
				method: "GET",
				headers: { Host: domain, Accept: "*/*", Connection: "close" },
				rejectUnauthorized: false,
				timeout: timeoutMs,
			}, (response) => {
				if (response.statusCode !== 200 || response.headers["cf-ray"] || String(response.headers.server ?? "").toLowerCase().includes("cloudflare")) {
					response.resume();
					return finish(false);
				}
				const hash = createHash("sha256");
				let bytes = 0;
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.byteLength;
					if (bytes > MAX_VERIFICATION_BODY_BYTES) return finish(false);
					hash.update(chunk);
				});
				response.once("end", () => finish(bytes > 0 && capturedKitResponseMatches(response.statusCode, response.headers, hash.digest("hex"), target.sha256)));
				response.once("error", () => finish(false));
			});
			request.once("timeout", () => finish(false));
			request.once("error", () => finish(false));
			request.end();
		});
		if (matched) return true;
	}
	return false;
};

/** Whether a certificate names a host, directly or through a one-label wildcard. */
export function certificateCovers(names: readonly string[], host: string): boolean {
	const wanted = host.toLowerCase();
	return names.some((name) => {
		const candidate = name.toLowerCase();
		if (candidate === wanted) return true;
		if (!candidate.startsWith("*.")) return false;
		const suffix = candidate.slice(2);
		return wanted.endsWith(`.${suffix}`) && wanted.split(".").length === suffix.split(".").length + 1;
	});
}

function certificateNames(certificate: X509Certificate): string[] {
	const names = new Set<string>();
	const commonName = certificate.subject.match(/(?:^|\n)CN=([^\n]+)/)?.[1];
	if (commonName) names.add(commonName.trim().toLowerCase());
	for (const entry of (certificate.subjectAltName ?? "").split(/,\s*/)) {
		if (entry.startsWith("DNS:")) names.add(entry.slice(4).trim().toLowerCase());
	}
	return [...names].filter((name) => name.length <= 253).slice(0, 100);
}

/**
 * Ask one address for a domain's certificate, the way a browser would. It
 * only completes a TLS handshake and never sends an HTTP request.
 */
export const presentedCertificate: TlsProbe = (ip, serverName, timeoutMs) => new Promise((resolve) => {
	let settled = false;
	const finish = (value: PresentedCertificate | undefined) => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(value);
	};
	const socket = tls.connect({ host: ip, port: 443, servername: serverName, rejectUnauthorized: false, timeout: timeoutMs }, () => {
		const raw = socket.getPeerX509Certificate();
		if (!raw) return finish(undefined);
		try {
			finish({
				names: certificateNames(raw),
				notBefore: new Date(raw.validFrom).toISOString(),
				notAfter: new Date(raw.validTo).toISOString(),
				issuer: raw.issuer.replace(/\n/g, ", ").slice(0, 500),
				fingerprint256: raw.fingerprint256,
			});
		} catch {
			finish(undefined);
		}
	});
	socket.once("timeout", () => finish(undefined));
	socket.once("error", () => finish(undefined));
});

const ipv4Integer = (address: ipaddr.IPv4) => address.toByteArray().reduce((value, byte) => value * 256 + byte, 0);

function ipv4FromInteger(value: number): string {
	return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function ipv4Range(item: OriginSweepPrefix): OriginSweepRange | undefined {
	try {
		if (!item.prefix.includes(".")) return undefined;
		const [network, bits] = ipaddr.parseCIDR(item.prefix);
		if (network.kind() !== "ipv4" || bits < 8 || bits > 32) return undefined;
		const size = 2 ** (32 - bits);
		const start = ipv4Integer(network as ipaddr.IPv4) - (ipv4Integer(network as ipaddr.IPv4) % size);
		return { ...item, start, end: start + size - 1 };
	} catch {
		return undefined;
	}
}

/** Sorted, disjoint, inclusive integer intervals. */
class IntervalSet {
	private readonly items: Array<[number, number]> = [];

	private firstEndingAtOrAfter(value: number): number {
		let low = 0;
		let high = this.items.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.items[middle]![1] < value) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	/** The parts of [start, end] this set does not contain, in ascending order. */
	gaps(start: number, end: number): Array<[number, number]> {
		const gaps: Array<[number, number]> = [];
		let cursor = start;
		for (let index = this.firstEndingAtOrAfter(start); index < this.items.length && cursor <= end; index++) {
			const [itemStart, itemEnd] = this.items[index]!;
			if (itemStart > end) break;
			if (itemStart > cursor) gaps.push([cursor, itemStart - 1]);
			cursor = Math.max(cursor, itemEnd + 1);
		}
		if (cursor <= end) gaps.push([cursor, end]);
		return gaps;
	}

	add(start: number, end: number): void {
		const first = this.firstEndingAtOrAfter(start - 1);
		let last = first;
		let mergedStart = start;
		let mergedEnd = end;
		while (last < this.items.length && this.items[last]![0] <= end + 1) {
			mergedStart = Math.min(mergedStart, this.items[last]![0]);
			mergedEnd = Math.max(mergedEnd, this.items[last]![1]);
			last++;
		}
		this.items.splice(first, last - first, [mergedStart, mergedEnd]);
	}

	get size(): number {
		return this.items.reduce((sum, [start, end]) => sum + end - start + 1, 0);
	}
}

function nonPublicIpv4(): IntervalSet {
	const blocked = new IntervalSet();
	for (const [base, bits] of NON_PUBLIC_IPV4) {
		const start = ipv4Integer(ipaddr.IPv4.parse(base));
		blocked.add(start, start + 2 ** (32 - bits) - 1);
	}
	return blocked;
}

/**
 * Build a deterministic plan over the public IPv4 space of the given
 * prefixes, capped at `limit` addresses. The plan holds integer ranges, so a
 * multi-million-address sweep never materializes its address list.
 */
export function planOriginSweep(prefixes: readonly OriginSweepPrefix[], limit = MAX_SWEEP_ADDRESSES): OriginSweepPlan {
	const cap = Math.min(MAX_SWEEP_ADDRESSES, Math.max(1, Math.floor(limit)));
	const ranges = prefixes.map(ipv4Range).filter((range) => range !== undefined);
	const union = nonPublicIpv4();
	const blockedSize = union.size;
	for (const range of ranges) union.add(range.start, range.end);
	const totalAddresses = union.size - blockedSize;

	// Cover complete small allocations before consuming the cap on a large one;
	// preserve ASN discovery order as the tie-breaker.
	const priority = [...ranges].sort((a, b) => (a.end - a.start) - (b.end - b.start));
	const covered = nonPublicIpv4();
	const selected: OriginSweepRange[] = [];
	const selectedPrefixes = new Map<string, OriginSweepPrefix>();
	let addressCount = 0;
	for (const range of priority) {
		for (const [start, gapEnd] of covered.gaps(range.start, range.end)) {
			if (addressCount >= cap) break;
			const end = Math.min(gapEnd, start + cap - addressCount - 1);
			selected.push({ asn: range.asn, prefix: range.prefix, start, end });
			covered.add(start, end);
			addressCount += end - start + 1;
			selectedPrefixes.set(`${range.asn}:${range.prefix}`, { asn: range.asn, prefix: range.prefix });
		}
		if (addressCount >= cap) break;
	}
	return {
		ranges: selected,
		addressCount,
		selectedPrefixes: [...selectedPrefixes.values()],
		totalAddresses,
		truncated: addressCount < totalAddresses,
	};
}

/** The plan's addresses from position `offset`, at most `count` of them. */
export function originSweepAddresses(plan: OriginSweepPlan, offset: number, count: number): string[] {
	const addresses: string[] = [];
	let skip = Math.max(0, offset);
	for (const range of plan.ranges) {
		const size = range.end - range.start + 1;
		if (skip >= size) {
			skip -= size;
			continue;
		}
		for (let value = range.start + skip; value <= range.end && addresses.length < count; value++) addresses.push(ipv4FromInteger(value));
		skip = 0;
		if (addresses.length >= count) break;
	}
	return addresses;
}

/**
 * Find addresses that both present the domain's certificate and serve exact
 * captured kit bytes without a Cloudflare response. Certificate presentation
 * alone is only a relay candidate and is deliberately not returned.
 */
export async function findOriginServers(params: {
	domain: string;
	addresses: readonly string[];
	verificationTargets: readonly OriginVerificationTarget[];
	probe?: TlsProbe;
	verify?: OriginVerifier;
	concurrency?: number;
	timeoutMs?: number;
	maxResults?: number;
	signal?: AbortSignal;
}): Promise<OriginServer[]> {
	const probe = params.probe ?? presentedCertificate;
	const verify = params.verify ?? servesCapturedKit;
	const timeoutMs = params.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	const found: OriginServer[] = [];
	const maximum = Math.min(MAX_ORIGIN_RESULTS, Math.max(1, params.maxResults ?? MAX_ORIGIN_RESULTS));
	let next = 0;
	const worker = async () => {
		while (next < params.addresses.length) {
			if (params.signal?.aborted) throw params.signal.reason ?? new Error("Origin sweep was canceled.");
			const ip = params.addresses[next++]!;
			const certificate = await probe(ip, params.domain, timeoutMs);
			if (certificate
				&& certificateCovers(certificate.names, params.domain)
				&& await verify(ip, params.domain, params.verificationTargets, timeoutMs)
				&& found.length < maximum) found.push({ ip, certificate });
		}
	};
	const concurrency = Math.min(512, Math.max(1, params.concurrency ?? DEFAULT_CONCURRENCY));
	await Promise.all(Array.from({ length: Math.min(concurrency, params.addresses.length) }, worker));
	return found.slice(0, maximum).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}
