import { isIP } from "node:net";

import { fetchJson } from "./bounded_fetch";
import { DAY_MS } from "../duration";

/**
 * Finds the authoritative RDAP server for a domain, IP address, or AS number
 * from IANA's bootstrap registries (RFC 9224), so lookups go straight to the
 * registry or RIR that holds the record. A public redirector such as rdap.org
 * rate-limits every caller behind one shared budget: under load it answered
 * HTTP 429, and the hosting provider's abuse contact was never found.
 */

export type RdapObject = "domain" | "ip" | "autnum";

/** The URL of the record on its authoritative server, or undefined when IANA names no server for it. */
export type RdapLocator = (object: RdapObject, value: string) => Promise<string | undefined>;

type BootstrapFile = "dns" | "ipv4" | "ipv6" | "asn";
type BootstrapService = { entries: string[]; servers: string[] };

const BOOTSTRAP_BASE_URL = "https://data.iana.org/rdap/";
/** IANA asks clients to cache the registries; they change a few times a month. */
const REFRESH_MS = DAY_MS;

/** The services of one bootstrap registry: `[[entries], [server URLs]]` pairs. */
export function parseBootstrap(json: unknown): BootstrapService[] {
	const services = json && typeof json === "object" ? (json as { services?: unknown }).services : undefined;
	if (!Array.isArray(services)) throw new Error("The RDAP bootstrap registry has no services.");
	return services.flatMap((service) => {
		if (!Array.isArray(service) || !Array.isArray(service[0]) || !Array.isArray(service[1])) return [];
		const strings = (values: unknown[]) => values.filter((value): value is string => typeof value === "string");
		return [{ entries: strings(service[0]).map((entry) => entry.toLowerCase()), servers: strings(service[1]) }];
	});
}

/** An IPv4 or IPv6 address as a number and its width in bits, or undefined when it is not one. */
function addressBits(address: string): { value: bigint; bits: 32 | 128 } | undefined {
	const version = isIP(address);
	if (version === 4) {
		return { value: address.split(".").reduce((sum, octet) => (sum << 8n) | BigInt(Number(octet)), 0n), bits: 32 };
	}
	if (version !== 6) return undefined;
	let text = address.toLowerCase().split("%")[0]!;
	// An embedded IPv4 tail (`::ffff:192.0.2.1`) becomes two hextets.
	const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) {
		const tail = addressBits(v4[1]!)!.value;
		text = `${text.slice(0, -v4[1]!.length)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
	}
	const [head, rest] = text.split("::") as [string, string | undefined];
	const left = head ? head.split(":") : [];
	const right = rest === undefined ? [] : rest ? rest.split(":") : [];
	const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
	return { value: groups.reduce((sum, group) => (sum << 16n) | BigInt(parseInt(group, 16)), 0n), bits: 128 };
}

/** The prefix length when `address` falls inside `cidr`, else -1. */
function prefixMatch(address: { value: bigint; bits: number }, cidr: string): number {
	const [network, lengthText] = cidr.split("/");
	const prefix = network ? addressBits(network) : undefined;
	const length = Number(lengthText ?? (prefix?.bits ?? 0));
	if (!prefix || prefix.bits !== address.bits || !Number.isInteger(length) || length < 0 || length > prefix.bits) return -1;
	const shift = BigInt(prefix.bits - length);
	return (address.value >> shift) === (prefix.value >> shift) ? length : -1;
}

/** The servers of the most specific service that covers `value`. */
export function bootstrapServers(file: BootstrapFile, services: readonly BootstrapService[], value: string): string[] | undefined {
	if (file === "dns") {
		const labels = value.toLowerCase().replace(/\.$/, "").split(".");
		// The longest matching label suffix wins (an entry may be a multi-label zone).
		for (let start = 0; start < labels.length; start++) {
			const zone = labels.slice(start).join(".");
			const service = services.find((candidate) => candidate.entries.includes(zone));
			if (service) return service.servers;
		}
		return undefined;
	}
	if (file === "asn") {
		const asn = Number(value);
		return services.find((service) => service.entries.some((entry) => {
			const [low, high = low] = entry.split("-").map(Number);
			return low !== undefined && asn >= low && asn <= high!;
		}))?.servers;
	}
	const address = addressBits(value);
	if (!address) return undefined;
	let best: { length: number; servers: string[] } | undefined;
	for (const service of services) {
		for (const entry of service.entries) {
			const length = prefixMatch(address, entry);
			if (length > (best?.length ?? -1)) best = { length, servers: service.servers };
		}
	}
	return best?.servers;
}

function bootstrapFile(object: RdapObject, value: string): BootstrapFile {
	if (object === "domain") return "dns";
	if (object === "autnum") return "asn";
	return isIP(value) === 6 ? "ipv6" : "ipv4";
}

/** The record's URL on the first HTTPS server; addresses and AS numbers go unescaped, as RFC 9082 writes them. */
function recordUrl(servers: readonly string[], object: RdapObject, value: string): string | undefined {
	const base = servers.find((server) => server.startsWith("https://"));
	if (!base) return undefined;
	const key = object === "domain" ? encodeURIComponent(value.toLowerCase().replace(/\.$/, "")) : value;
	return `${base.endsWith("/") ? base : `${base}/`}${object}/${key}`;
}

/**
 * A locator over IANA's registries, loaded through `load` on first use and
 * reloaded a day later. A failed load is not cached, so the next lookup tries again.
 */
export function ianaRdapLocator(load: (url: string) => Promise<unknown>, now: () => number = Date.now): RdapLocator {
	const registries = new Map<BootstrapFile, { loadedAt: number; services: Promise<BootstrapService[]> }>();
	const servicesOf = (file: BootstrapFile): Promise<BootstrapService[]> => {
		const cached = registries.get(file);
		if (cached && now() - cached.loadedAt < REFRESH_MS) return cached.services;
		const services = load(`${BOOTSTRAP_BASE_URL}${file}.json`).then(parseBootstrap);
		const entry = { loadedAt: now(), services };
		registries.set(file, entry);
		services.catch(() => {
			if (registries.get(file) === entry) registries.delete(file);
		});
		return services;
	};
	return async (object, value) => {
		const file = bootstrapFile(object, value);
		const servers = bootstrapServers(file, await servicesOf(file), value);
		return servers ? recordUrl(servers, object, value) : undefined;
	};
}

/** The process-wide locator: one copy of each registry for every lookup. */
export const defaultRdapLocator: RdapLocator = ianaRdapLocator(async (url) => {
	const json = await fetchJson<unknown>(url, { method: "GET", headers: { Accept: "application/json" } }, { timeoutMs: 15_000, attempts: 3, retryDelayMs: 1_000 });
	if (json === undefined) throw new Error(`The RDAP bootstrap registry ${url} was not found.`);
	return json;
});
