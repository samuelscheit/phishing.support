import { z } from "zod";

import { fetchJson, type FetchImplementation } from "./bounded_fetch";

const RIPESTAT = "https://stat.ripe.net/data";
const SOURCE_APP = "phishing-support";

const envelopeSchema = z.object({ status: z.string(), data: z.unknown() }).passthrough();

export type RipeStatDependencies = { fetch?: FetchImplementation };

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

const networkInfoSchema = z.object({ asns: z.array(z.union([z.string(), z.number()])) }).passthrough();

/** The AS numbers that announce an IP address. */
export async function originAsns(ip: string, dependencies: RipeStatDependencies = {}): Promise<number[]> {
	const parsed = networkInfoSchema.safeParse(await ripeStatData("network-info", { resource: ip }, dependencies));
	return parsed.success ? parsed.data.asns.map(Number).filter((asn) => Number.isSafeInteger(asn) && asn > 0) : [];
}

/** Where MaxMind's GeoLite database places an IP address; meaningless for anycast CDN addresses. */
export async function locatedCountry(ip: string, dependencies: RipeStatDependencies = {}): Promise<string | undefined> {
	const parsed = locatedSchema.safeParse(await ripeStatData("maxmind-geo-lite", { resource: ip }, dependencies));
	return parsed.success ? onlyCountry(parsed.data.located_resources.flatMap((entry) => entry.locations.map((location) => location.country))) : undefined;
}
