import { X509Certificate } from "node:crypto";
import tls from "node:tls";

import ipaddr from "ipaddr.js";

import { isPublicIp } from "../security";

/** The largest IPv4 address space one host may be swept across: a /16. */
export const MAX_SWEEP_ADDRESSES = 65_536;
const DEFAULT_CONCURRENCY = 256;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_500;
const MAX_ORIGIN_RESULTS = 16;

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
export type OriginSweepPlan = {
	addresses: string[];
	selectedPrefixes: OriginSweepPrefix[];
	totalAddresses: number;
	truncated: boolean;
};

export type TlsProbe = (ip: string, serverName: string, timeoutMs: number) => Promise<PresentedCertificate | undefined>;

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

function ipv4Range(item: OriginSweepPrefix): (OriginSweepPrefix & { start: number; end: number; size: number }) | undefined {
	try {
		if (!item.prefix.includes(".")) return undefined;
		const [network, bits] = ipaddr.parseCIDR(item.prefix);
		if (network.kind() !== "ipv4" || bits < 8 || bits > 32) return undefined;
		const base = (network as ipaddr.IPv4).toByteArray().reduce((value, byte) => value * 256 + byte, 0);
		const size = 2 ** (32 - bits);
		const start = base - (base % size);
		const first = [start >>> 24, (start >>> 16) & 255, (start >>> 8) & 255, start & 255].join(".");
		const end = start + size - 1;
		const last = [end >>> 24, (end >>> 16) & 255, (end >>> 8) & 255, end & 255].join(".");
		if (!isPublicIp(first) || !isPublicIp(last)) return undefined;
		return { ...item, start, end, size };
	} catch {
		return undefined;
	}
}

/** Build a deterministic public-IPv4 plan capped at one /16 of TLS handshakes. */
export function planOriginSweep(prefixes: readonly OriginSweepPrefix[], limit = MAX_SWEEP_ADDRESSES): OriginSweepPlan {
	const cap = Math.min(MAX_SWEEP_ADDRESSES, Math.max(1, Math.floor(limit)));
	const ranges = prefixes.map(ipv4Range).filter((range) => range !== undefined);
	const byAddress = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: Array<[number, number]> = [];
	for (const range of byAddress) {
		const last = merged.at(-1);
		if (last && range.start <= last[1] + 1) last[1] = Math.max(last[1], range.end);
		else merged.push([range.start, range.end]);
	}
	const totalAddresses = merged.reduce((sum, [start, end]) => sum + end - start + 1, 0);

	// Cover complete small allocations before consuming the cap on a large one;
	// preserve ASN discovery order as the tie-breaker.
	const priority = [...ranges].sort((a, b) => a.size - b.size);
	const addresses: string[] = [];
	const seen = new Set<number>();
	const selectedPrefixes: OriginSweepPrefix[] = [];
	for (const range of priority) {
		let used = false;
		for (let value = range.start; value <= range.end && addresses.length < cap; value++) {
			if (seen.has(value)) continue;
			const ip = [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
			if (!isPublicIp(ip)) continue;
			seen.add(value);
			addresses.push(ip);
			used = true;
		}
		if (used) selectedPrefixes.push({ asn: range.asn, prefix: range.prefix });
		if (addresses.length >= cap) break;
	}
	return { addresses, selectedPrefixes, totalAddresses, truncated: addresses.length < totalAddresses };
}

/**
 * Find the servers in a host's own address space that present a certificate
 * for the domain. A domain behind Cloudflare keeps its real server secret, but
 * that server still holds the domain's certificate and shows it to anyone who
 * asks for the domain by name.
 */
export async function findOriginServers(params: {
	domain: string;
	addresses: readonly string[];
	probe?: TlsProbe;
	concurrency?: number;
	timeoutMs?: number;
	maxResults?: number;
	signal?: AbortSignal;
}): Promise<OriginServer[]> {
	const probe = params.probe ?? presentedCertificate;
	const timeoutMs = params.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	const found: OriginServer[] = [];
	const maximum = Math.min(MAX_ORIGIN_RESULTS, Math.max(1, params.maxResults ?? MAX_ORIGIN_RESULTS));
	let next = 0;
	const worker = async () => {
		while (next < params.addresses.length && found.length < maximum) {
			if (params.signal?.aborted) throw params.signal.reason ?? new Error("Origin sweep was canceled.");
			const ip = params.addresses[next++]!;
			const certificate = await probe(ip, params.domain, timeoutMs);
			if (certificate && certificateCovers(certificate.names, params.domain)) found.push({ ip, certificate });
		}
	};
	const concurrency = Math.min(512, Math.max(1, params.concurrency ?? DEFAULT_CONCURRENCY));
	await Promise.all(Array.from({ length: Math.min(concurrency, params.addresses.length) }, worker));
	return found.slice(0, maximum).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}
