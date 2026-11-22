import ipaddr from "ipaddr.js";
import { getDomain } from "tldts";
import { z } from "zod";

import { isPublicIp, normalizeDomain } from "../abuse/security/security";
import { type FetchLike } from "../http/fetch";
import { errorSummary } from "../util/error_text";
import { fetchJson, RequestStatusError } from "./bounded_fetch";
import { VIRUSTOTAL_API, virusTotalApiKey } from "./virustotal";

/**
 * Passive DNS: the addresses a domain resolved to in the past, as sensors and
 * scanners saw them. A site behind a CDN today often resolved straight to its
 * own server before it moved there, which names its real host.
 */

export const passiveDnsSources = ["virustotal"] as const;
export type PassiveDnsSourceName = (typeof passiveDnsSources)[number];

const SOURCE_LABELS: Record<PassiveDnsSourceName, string> = { virustotal: "VirusTotal" };

export function passiveDnsSourceLabel(source: PassiveDnsSourceName): string {
	return SOURCE_LABELS[source];
}

/** One host-to-address resolution, merged over every source that saw it. */
export type PassiveDnsRecord = {
	host: string;
	ip: string;
	type: "A" | "AAAA";
	/** Earliest sighting, when a source tells it (VirusTotal keeps only the latest). */
	firstSeen?: string;
	lastSeen: string;
	sources: PassiveDnsSourceName[];
};

type SourceRecord = Omit<PassiveDnsRecord, "type" | "sources">;

export type PassiveDnsSource = {
	name: PassiveDnsSourceName;
	/** The host's resolutions; throws when the source cannot answer now. */
	resolutions(host: string, signal?: AbortSignal): Promise<SourceRecord[]>;
};

export type PassiveDnsHistory = {
	/** The hosts asked about, in order, and the sources asked. */
	hosts: string[];
	sources: PassiveDnsSourceName[];
	/** Public addresses only, most recently seen first. */
	records: PassiveDnsRecord[];
	/** Why a source or a host could not be asked; the others still answer. */
	errors: string[];
};

const MAX_RECORDS_PER_HOST = 40;

const resolutionsSchema = z.object({
	data: z.array(z.object({
		attributes: z.object({
			date: z.number().int().positive(),
			host_name: z.string(),
			ip_address: z.string(),
		}).passthrough(),
	}).passthrough()),
}).passthrough();

/**
 * VirusTotal's `resolutions` relationship of a domain: one object per address
 * the host was seen at, dated by its latest sighting. One page (40, the
 * maximum) per host keeps each lookup a single request of the daily quota.
 */
export function virusTotalPassiveDns(options: { environment?: Readonly<Record<string, string | undefined>>; fetch?: FetchLike; timeoutMs?: number } = {}): PassiveDnsSource {
	return {
		name: "virustotal",
		async resolutions(host) {
			const apiKey = virusTotalApiKey(options.environment);
			if (!apiKey) throw new Error("VIRUSTOTAL_API_KEY is not set");
			let response: unknown;
			try {
				response = await fetchJson<unknown>(
					`${VIRUSTOTAL_API}/domains/${encodeURIComponent(host)}/resolutions?limit=${MAX_RECORDS_PER_HOST}`,
					{ method: "GET", headers: { "x-apikey": apiKey, accept: "application/json" } },
					// A retried 429 spends quota the next lookup needs; one attempt each.
					{ fetch: options.fetch, timeoutMs: options.timeoutMs ?? 15_000, attempts: 1, maxResponseBytes: 2 * 1024 * 1024 },
				);
			} catch (error) {
				if (error instanceof RequestStatusError && error.status === 429) throw new Error("quota exhausted (HTTP 429)");
				if (error instanceof RequestStatusError && (error.status === 401 || error.status === 403)) throw new Error(`the API key was refused (HTTP ${error.status})`);
				throw error;
			}
			// 404 NotFoundError: VirusTotal has never seen the host.
			if (response === undefined) return [];
			const parsed = resolutionsSchema.safeParse(response);
			if (!parsed.success) throw new Error("returned an invalid resolutions response");
			return parsed.data.data.flatMap(({ attributes }) => attributes.host_name.toLowerCase() === host
				? [{ host, ip: attributes.ip_address, lastSeen: new Date(attributes.date * 1000).toISOString() }]
				: []);
		},
	};
}

/**
 * The hosts whose history can tell where a domain's site ran: the domain, and
 * its site (the registrable domain, a tenant on a shared platform's suffix)
 * and that site's `www`, which kits are often deployed on first.
 */
export function passiveDnsHosts(domain: string): string[] {
	const host = normalizeDomain(domain);
	if (!host) return [];
	const site = getDomain(host, { allowPrivateDomains: true }) ?? host;
	return [...new Set([host, site, `www.${site}`])];
}

function canonicalAddress(value: string): { ip: string; type: "A" | "AAAA" } | undefined {
	if (!ipaddr.isValid(value) || !isPublicIp(value)) return undefined;
	const address = ipaddr.parse(value);
	return { ip: address.toString(), type: address.kind() === "ipv4" ? "A" : "AAAA" };
}

/**
 * Ask every source about every host. A source without its key, out of quota or
 * down is recorded in `errors` and the rest still answer; nothing here throws
 * except cancellation.
 */
export async function passiveDnsHistory(domain: string, options: { sources?: readonly PassiveDnsSource[]; signal?: AbortSignal } = {}): Promise<PassiveDnsHistory> {
	const hosts = passiveDnsHosts(domain);
	const sources = options.sources ?? [virusTotalPassiveDns()];
	const errors: string[] = [];
	const merged = new Map<string, PassiveDnsRecord>();
	await Promise.all(sources.flatMap((source) => hosts.map(async (host) => {
		let found: SourceRecord[];
		try {
			found = await source.resolutions(host, options.signal);
		} catch (error) {
			options.signal?.throwIfAborted();
			errors.push(`passive DNS ${source.name} for ${host}: ${errorSummary(error)}`);
			return;
		}
		for (const record of found) {
			const address = canonicalAddress(record.ip);
			const lastSeen = Date.parse(record.lastSeen);
			if (!address || Number.isNaN(lastSeen)) continue;
			const firstSeen = record.firstSeen === undefined ? undefined : Date.parse(record.firstSeen);
			const key = `${host} ${address.ip}`;
			const existing = merged.get(key);
			const earliest = [existing?.firstSeen, firstSeen === undefined || Number.isNaN(firstSeen) ? undefined : new Date(firstSeen).toISOString()]
				.filter((value): value is string => value !== undefined).sort()[0];
			merged.set(key, {
				host,
				...address,
				...(earliest ? { firstSeen: earliest } : {}),
				lastSeen: [existing?.lastSeen, new Date(lastSeen).toISOString()].filter((value): value is string => value !== undefined).sort().at(-1)!,
				sources: [...new Set([...(existing?.sources ?? []), source.name])].sort(),
			});
		}
	})));
	options.signal?.throwIfAborted();
	const hostOrder = (host: string) => hosts.indexOf(host);
	return {
		hosts,
		sources: [...new Set(sources.map(({ name }) => name))],
		records: [...merged.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || hostOrder(a.host) - hostOrder(b.host) || a.ip.localeCompare(b.ip, undefined, { numeric: true })),
		errors: errors.sort(),
	};
}
