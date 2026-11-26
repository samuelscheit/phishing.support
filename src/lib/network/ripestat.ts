import { z } from "zod";

import { fetchJson } from "./bounded_fetch";
import { type FetchLike } from "../http/fetch";

const RIPESTAT = "https://stat.ripe.net/data";
const SOURCE_APP = "phishing-support";

const envelopeSchema = z.object({ status: z.string(), data: z.unknown() }).passthrough();

export type RipeStatDependencies = { fetch?: FetchLike };

/** One RIPEstat data call; throws unless RIPEstat answers `ok`. */
export async function ripeStatData(endpoint: string, parameters: Record<string, string>, dependencies: RipeStatDependencies = {}): Promise<unknown> {
	const query = new URLSearchParams({ ...parameters, sourceapp: SOURCE_APP });
	const response = await fetchJson<unknown>(`${RIPESTAT}/${endpoint}/data.json?${query}`, { method: "GET", headers: { Accept: "application/json" } }, {
		fetch: dependencies.fetch,
		timeoutMs: 12_000,
		attempts: 2,
		maxResponseBytes: 4 * 1024 * 1024,
	});
	const envelope = envelopeSchema.safeParse(response);
	if (!envelope.success || envelope.data.status !== "ok") throw new Error(`RIPEstat ${endpoint} returned an invalid response.`);
	return envelope.data.data;
}

const COUNTRY = /^[A-Z]{2}$/;

const registeredSchema = z.object({ located_resources: z.array(z.object({ location: z.string() }).passthrough()) }).passthrough();
const locatedSchema = z.object({
	located_resources: z.array(z.object({ locations: z.array(z.object({ country: z.string() }).passthrough()) }).passthrough()),
}).passthrough();

/** The single country in a list, or undefined when there is none or they disagree. */
function onlyCountry(countries: readonly string[]): string | undefined {
	const distinct = [...new Set(countries.map((country) => country.toUpperCase()).filter((country) => COUNTRY.test(country)))];
	return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * The country a Regional Internet Registry delegated an IP address or AS
 * number to (`AS19318`, `192.0.2.1`): where the network's holder registered
 * it, not where a server stands.
 */
export async function registeredCountry(resource: string, dependencies: RipeStatDependencies = {}): Promise<string | undefined> {
	const parsed = registeredSchema.safeParse(await ripeStatData("rir-stats-country", { resource }, dependencies));
	return parsed.success ? onlyCountry(parsed.data.located_resources.map((entry) => entry.location)) : undefined;
}

const networkInfoSchema = z.object({ asns: z.array(z.union([z.string(), z.number()])), prefix: z.string().nullable().optional() }).passthrough();

/** The AS numbers that announce an IP address, and the announced prefix that holds it. */
export async function ipNetwork(ip: string, dependencies: RipeStatDependencies = {}): Promise<{ asns: number[]; prefix?: string }> {
	const parsed = networkInfoSchema.safeParse(await ripeStatData("network-info", { resource: ip }, dependencies));
	if (!parsed.success) return { asns: [] };
	const asns = parsed.data.asns.map(Number).filter((asn) => Number.isSafeInteger(asn) && asn > 0);
	return { asns, ...(parsed.data.prefix ? { prefix: parsed.data.prefix } : {}) };
}

/** The AS numbers that announce an IP address. */
export async function originAsns(ip: string, dependencies: RipeStatDependencies = {}): Promise<number[]> {
	return (await ipNetwork(ip, dependencies)).asns;
}

const overviewSchema = z.object({ holder: z.string().nullable().optional() }).passthrough();

/** Who holds an autonomous system, as RIPEstat names it: "CLOUDFLARENET - Cloudflare, Inc., US", "Sollutium-NL SOLLUTIUM EU Sp z.o.o.". */
export async function asHolder(asn: number, dependencies: RipeStatDependencies = {}): Promise<string | undefined> {
	const parsed = overviewSchema.safeParse(await ripeStatData("as-overview", { resource: `AS${asn}` }, dependencies));
	if (!parsed.success) throw new Error("RIPEstat as-overview response was malformed.");
	return parsed.data.holder?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined;
}

/**
 * The AS name a holder starts with, which is what a network calls itself:
 * "CLOUDFLARENET - Cloudflare, Inc., US" → "CLOUDFLARENET", "Sollutium-NL
 * SOLLUTIUM EU Sp z.o.o." → "Sollutium-NL". A holder that starts with a plain
 * word ("Example Hosting GmbH") is a name already and stays whole.
 */
export function asHolderName(holder: string): string {
	const trimmed = holder.trim();
	const named = trimmed.match(/^(\S+) - /)?.[1];
	if (named) return named;
	const [first = trimmed, ...rest] = trimmed.split(/\s+/);
	return rest.length && (/[-_\d]/.test(first) || first === first.toUpperCase()) ? first : trimmed;
}

/** Where MaxMind's GeoLite database places an IP address; meaningless for anycast CDN addresses. */
export async function locatedCountry(ip: string, dependencies: RipeStatDependencies = {}): Promise<string | undefined> {
	const parsed = locatedSchema.safeParse(await ripeStatData("maxmind-geo-lite", { resource: ip }, dependencies));
	return parsed.success ? onlyCountry(parsed.data.located_resources.flatMap((entry) => entry.locations.map((location) => location.country))) : undefined;
}
