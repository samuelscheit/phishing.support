import dns from "node:dns/promises";

import { z } from "zod";

import { fetchJson, retryWithTimeout, type FetchImplementation } from "../../network/bounded_fetch";
import { isPublicIp, normalizeDomain, registrableDomain } from "../security";
import { normalizeMailbox } from "../mail/shared";
import { throwIfAborted } from "../worker/shared";
import { mapConcurrent } from "./concurrency";
import { errorSummary } from "../../error_text";

const RIPESTAT = "https://stat.ripe.net/data";
const SOURCE_APP = "phishing-support";
const MAX_CANDIDATE_ASNS = 24;
const MAX_DNS_ADDRESSES = 24;

const responseSchema = z.object({ status: z.string(), data: z.unknown() }).passthrough();
const searchSchema = z.object({
	categories: z.array(z.object({
		category: z.string(),
		suggestions: z.array(z.object({ value: z.string().optional(), label: z.string().optional() }).passthrough()),
	}).passthrough()),
}).passthrough();
const networkInfoSchema = z.object({ asns: z.array(z.union([z.string(), z.number()])) }).passthrough();
const abuseContactsSchema = z.object({ abuse_contacts: z.array(z.string()) }).passthrough();
const overviewSchema = z.object({ holder: z.string().nullable().optional() }).passthrough();
const prefixesSchema = z.object({
	prefixes: z.array(z.object({ prefix: z.string() }).passthrough()),
}).passthrough();

export type OriginHostNetwork = {
	asn: number;
	holder: string;
	prefixes: string[];
	discoverySources: string[];
};

export type OriginNetworkResolution = {
	recipient: string;
	mailboxDomain: string;
	networks: OriginHostNetwork[];
	errors: string[];
};

export type OriginNetworkDependencies = {
	fetch?: FetchImplementation;
	resolve4?: (hostname: string) => Promise<string[]>;
	resolveMx?: (hostname: string) => Promise<Array<{ exchange: string; priority: number }>>;
};

function asnNumber(value: unknown): number | undefined {
	const match = String(value ?? "").toUpperCase().match(/^(?:AS)?(\d{1,10})$/);
	const asn = match ? Number(match[1]) : Number.NaN;
	return Number.isSafeInteger(asn) && asn > 0 && asn <= 4_294_967_295 ? asn : undefined;
}

async function ripeData(
	endpoint: string,
	parameters: Record<string, string>,
	dependencies: OriginNetworkDependencies,
): Promise<unknown> {
	const query = new URLSearchParams({ ...parameters, sourceapp: SOURCE_APP });
	const response = await fetchJson<unknown>(`${RIPESTAT}/${endpoint}/data.json?${query}`, { method: "GET", headers: { Accept: "application/json" } }, {
		fetch: dependencies.fetch,
		timeoutMs: 12_000,
		attempts: 2,
		maxResponseBytes: 4 * 1024 * 1024,
	});
	const envelope = responseSchema.safeParse(response);
	if (!envelope.success || envelope.data.status !== "ok") throw new Error(`RIPEstat ${endpoint} returned an invalid response.`);
	return envelope.data.data;
}

async function boundedDns<T>(label: string, operation: () => Promise<T>): Promise<T> {
	return retryWithTimeout(operation, { label, timeoutMs: 5_000, attempts: 2, retryDelayMs: 200 });
}

/**
 * Resolve an explicitly disclosed abuse mailbox to ASNs, then require the
 * registry's abuse-contact endpoint to name that exact mailbox. Search hints
 * and DNS hosting alone can therefore never authorize a network sweep.
 */
export async function resolveOriginHostNetworks(
	recipientValue: string,
	signal?: AbortSignal,
	dependencies: OriginNetworkDependencies = {},
): Promise<OriginNetworkResolution> {
	const recipient = normalizeMailbox(recipientValue);
	if (!recipient) throw new Error("Cloudflare supplied an invalid hosting-provider mailbox.");
	const mailboxDomain = normalizeDomain(recipient.split("@")[1] ?? "");
	if (!mailboxDomain) throw new Error("Cloudflare supplied a hosting-provider mailbox with an invalid domain.");
	const errors: string[] = [];
	const candidates = new Map<number, Set<string>>();
	const addCandidate = (asn: number | undefined, source: string) => {
		if (!asn || candidates.size >= MAX_CANDIDATE_ASNS && !candidates.has(asn)) return;
		const sources = candidates.get(asn) ?? new Set<string>();
		sources.add(source);
		candidates.set(asn, sources);
	};

	throwIfAborted(signal);
	try {
		const registrable = registrableDomain(mailboxDomain) ?? mailboxDomain;
		const term = registrable.split(".")[0]!;
		const parsed = searchSchema.safeParse(await ripeData("searchcomplete", { resource: term, limit: "20" }, dependencies));
		if (!parsed.success) throw new Error("RIPEstat search response was malformed.");
		for (const category of parsed.data.categories) {
			if (category.category.toLowerCase() !== "asns") continue;
			for (const suggestion of category.suggestions) addCandidate(asnNumber(suggestion.value ?? suggestion.label), "registry_name_search");
		}
	} catch (error) {
		errors.push(`registry search: ${errorSummary(error)}`);
	}

	const resolve4 = dependencies.resolve4 ?? dns.resolve4;
	const resolveMx = dependencies.resolveMx ?? dns.resolveMx;
	const dnsHosts = new Set([mailboxDomain]);
	try {
		for (const record of await boundedDns(`MX lookup for ${mailboxDomain}`, () => resolveMx(mailboxDomain))) {
			const exchange = normalizeDomain(record.exchange);
			if (exchange && dnsHosts.size < 12) dnsHosts.add(exchange);
		}
	} catch (error) {
		errors.push(`MX lookup: ${errorSummary(error)}`);
	}

	const discoveredIps: Array<{ ip: string; source: string }> = [];
	for (const host of dnsHosts) {
		try {
			for (const ip of await boundedDns(`A lookup for ${host}`, () => resolve4(host))) {
				if (isPublicIp(ip) && discoveredIps.length < MAX_DNS_ADDRESSES) discoveredIps.push({ ip, source: host === mailboxDomain ? "mailbox_domain_dns" : "mail_exchanger_dns" });
			}
		} catch (error) {
			errors.push(`A lookup for ${host}: ${errorSummary(error)}`);
		}
	}

	const networkCandidates = await mapConcurrent(discoveredIps, 4, async ({ ip, source }) => {
		try {
			throwIfAborted(signal);
			const parsed = networkInfoSchema.safeParse(await ripeData("network-info", { resource: ip }, dependencies));
			if (!parsed.success) throw new Error("RIPEstat network-info response was malformed.");
			return parsed.data.asns.map(asnNumber).filter((asn): asn is number => Boolean(asn)).map((asn) => ({ asn, source }));
		} catch (error) {
			errors.push(`network lookup for ${ip}: ${errorSummary(error)}`);
			return [];
		}
	});
	for (const group of networkCandidates) for (const candidate of group) addCandidate(candidate.asn, candidate.source);

	const validated = await mapConcurrent([...candidates], 4, async ([asn, sources]) => {
		try {
			throwIfAborted(signal);
			const contacts = abuseContactsSchema.safeParse(await ripeData("abuse-contact-finder", { resource: `AS${asn}` }, dependencies));
			if (!contacts.success) throw new Error("RIPEstat abuse-contact response was malformed.");
			if (!contacts.data.abuse_contacts.map(normalizeMailbox).includes(recipient)) return undefined;
			const [overviewResult, prefixesResult] = await Promise.all([
				ripeData("as-overview", { resource: `AS${asn}` }, dependencies),
				ripeData("announced-prefixes", { resource: `AS${asn}` }, dependencies),
			]);
			const overview = overviewSchema.safeParse(overviewResult);
			const prefixes = prefixesSchema.safeParse(prefixesResult);
			if (!overview.success || !prefixes.success) throw new Error("RIPEstat ASN response was malformed.");
			const holder = overview.data.holder?.replace(/\s+/g, " ").trim().slice(0, 200) || `AS${asn}`;
			return {
				asn,
				holder,
				prefixes: [...new Set(prefixes.data.prefixes.map(({ prefix }) => prefix))].slice(0, 2_048),
				discoverySources: [...sources],
			} satisfies OriginHostNetwork;
		} catch (error) {
			errors.push(`AS${asn}: ${errorSummary(error)}`);
			return undefined;
		}
	});

	const sourcePriority = (network: OriginHostNetwork) => network.discoverySources.includes("mail_exchanger_dns")
		? 0
		: network.discoverySources.includes("mailbox_domain_dns") ? 1 : 2;
	return {
		recipient,
		mailboxDomain,
		networks: validated
			.filter((network): network is OriginHostNetwork => Boolean(network))
			.sort((a, b) => sourcePriority(a) - sourcePriority(b) || a.asn - b.asn),
		errors,
	};
}
