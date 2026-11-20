import dns from "node:dns/promises";
import { isIP } from "node:net";

import type { InferInsertModel } from "drizzle-orm";

import { fetchRdapRecord } from "../abuse/resolver/http";
import type { ResolverDependencies } from "../abuse/resolver/types";
import { registrableDomain } from "../abuse/security";
import { browserRequestHeaders } from "../network/service_identity";
import { errorSummary } from "../util/error_text";
import { asRecord } from "../util/values";
import { readResponseBody, retryWithTimeout, withTimeout } from "../network/bounded_fetch";
import { fetchThroughPublicRedirects, PublicRedirectError } from "../network/public_redirects";
import { classifySite, siteOf, type DnsObservation, type HttpObservation } from "./classify";
import type { siteChecks } from "./schema";
import { urlHostname } from "../network/url";
import { type FetchLike } from "../http/fetch";

const DNS_TIMEOUT_MS = 5_000;
const RDAP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 8;
/** Takedown and parking pages are small; a page beyond this is the site itself and is judged by its status. */
const MAX_BODY_BYTES = 512 * 1024;

export type SiteDnsResolver = {
	resolve4(hostname: string): Promise<string[]>;
	resolve6(hostname: string): Promise<string[]>;
	resolveCname(hostname: string): Promise<string[]>;
};

export type SiteCheckDependencies = {
	/** Production asks the system's resolvers through node:dns. */
	dns?: SiteDnsResolver;
	/** The domain's RDAP lookup, with the resolver's SSRF guard and bootstrap. */
	rdap?: ResolverDependencies;
	fetch?: FetchLike;
	/** Guards every HTTP hop; production refuses hosts that resolve to private addresses. */
	assertPublicHost?: (hostname: string) => Promise<void>;
	signal?: AbortSignal;
	now?: () => Date;
};

/** One check's outcome, as stored for its target. */
export type SiteCheckResult = Omit<InferInsertModel<typeof siteChecks>, "id" | "reportId" | "targetId">;

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/** NXDOMAIN and "no record of this type" are answers; asking again cannot change them. */
const DEFINITIVE_DNS_CODES = new Set(["ENOTFOUND", "ENODATA"]);

function dnsLookup<T>(host: string, operation: () => Promise<T>): Promise<T> {
	return retryWithTimeout(operation, {
		label: `DNS lookup of ${host}`,
		timeoutMs: DNS_TIMEOUT_MS,
		attempts: 2,
		retryDelayMs: 250,
		shouldRetry: (error) => !DEFINITIVE_DNS_CODES.has(errorCode(error) ?? ""),
	});
}

/**
 * The host's addresses, or NXDOMAIN told apart from a resolver that did not
 * answer (SERVFAIL, timeout): only the first says the name is gone. A host
 * whose CNAME target is gone still exists itself, which `cname` records.
 */
async function observeDns(host: string, resolver: SiteDnsResolver): Promise<DnsObservation> {
	if (isIP(host)) return { outcome: "resolved", addresses: [host] };
	const results = await Promise.allSettled([dnsLookup(host, () => resolver.resolve4(host)), dnsLookup(host, () => resolver.resolve6(host))]);
	const addresses = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
	if (addresses.length) return { outcome: "resolved", addresses: [...new Set(addresses)] };
	const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (errors.some((error) => errorCode(error) === "ENOTFOUND")) {
		const cname = await dnsLookup(host, () => resolver.resolveCname(host)).then((names) => names[0], () => undefined);
		return { outcome: "nxdomain", ...(cname ? { cname } : {}) };
	}
	if (errors.length && errors.every((error) => errorCode(error) === "ENODATA")) return { outcome: "failed", error: "the name has no A or AAAA records." };
	return { outcome: "failed", error: [...new Set(errors.map((error) => errorCode(error) ?? errorSummary(error)))].join(", ") };
}

type RegistryObservation = { statuses: string[]; nameservers: string[] };
const EMPTY_REGISTRY: RegistryObservation = { statuses: [], nameservers: [] };

/**
 * The RDAP status values and delegated nameservers of the host's registrable domain. A platform
 * tenant's domain is the platform's, and an IP has none. RDAP is evidence
 * beside the visit, so its failure leaves the list empty.
 */
async function observeRegistry(host: string, rdap: ResolverDependencies): Promise<RegistryObservation> {
	if (isIP(host) || siteOf(host).platform) return EMPTY_REGISTRY;
	const domain = registrableDomain(host);
	if (!domain) return EMPTY_REGISTRY;
	try {
		const record = await withTimeout(() => fetchRdapRecord("domain", domain, rdap), RDAP_TIMEOUT_MS, `RDAP lookup of ${domain}`);
		const strings = (values: unknown): string[] => (Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : []);
		const nameservers = Array.isArray(record?.nameservers) ? record.nameservers.flatMap((server) => strings([asRecord(server)?.ldhName])) : [];
		return { statuses: strings(record?.status), nameservers };
	} catch {
		return EMPTY_REGISTRY;
	}
}

/** The body as text when it is text and fits the bound; a larger or binary body is not read. */
async function readPageText(response: Response): Promise<string | undefined> {
	const type = response.headers.get("content-type") ?? "";
	if (type && !/\b(?:text|html|xml|json)\b/i.test(type)) {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
	try {
		return (await readResponseBody(response, MAX_BODY_BYTES)).toString("utf8");
	} catch {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
}

function failureText(error: unknown): string {
	const cause = error instanceof PublicRedirectError ? error.cause : error;
	if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) return `the request timed out after ${REQUEST_TIMEOUT_MS / 1_000} s.`;
	const code = errorCode(cause);
	const message = errorSummary(cause);
	return code && !message.includes(code) ? `${code}: ${message}` : message;
}

/** Visit the URL as a desktop browser's first request would, following redirects by hand through public hosts only. */
async function observeHttp(url: string, dependencies: SiteCheckDependencies): Promise<HttpObservation> {
	try {
		const { response, urls } = await fetchThroughPublicRedirects(url, {
			...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
			...(dependencies.assertPublicHost ? { assertPublicHost: dependencies.assertPublicHost } : {}),
			...(dependencies.signal ? { signal: dependencies.signal } : {}),
			subject: "reported site",
			headers: { ...browserRequestHeaders },
			maxRedirects: MAX_REDIRECTS,
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		const headers: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			headers[name.toLowerCase()] = value;
		});
		const body = await readPageText(response);
		return { outcome: "response", urls, page: { status: response.status, url: urls.at(-1)!, headers, ...(body === undefined ? {} : { body }) } };
	} catch (error) {
		// The worker stopping or the job's deadline is not the site failing.
		if (dependencies.signal?.aborted) throw dependencies.signal.reason;
		return { outcome: "failed", error: failureText(error), urls: error instanceof PublicRedirectError ? [...error.urls] : [url] };
	}
}

/**
 * Check whether the reported URL still serves the site: DNS of its host,
 * the RDAP status of its domain, and one visit. Only a name that is gone
 * skips the visit; a resolver that failed to answer does not, since the
 * visit itself shows whether the site is reachable.
 */
export async function checkSite(url: string, dependencies: SiteCheckDependencies = {}): Promise<SiteCheckResult> {
	const checkedAt = (dependencies.now ?? (() => new Date()))();
	const host = urlHostname(new URL(url));
	const registryObservation = observeRegistry(host, dependencies.rdap ?? {});
	const dnsObservation = await observeDns(host, dependencies.dns ?? dns);
	const http = dnsObservation.outcome === "nxdomain" ? undefined : await observeHttp(url, dependencies);
	const { statuses, nameservers } = await registryObservation;
	const verdict = classifySite({ url, dns: dnsObservation, domainStatuses: statuses, nameservers, ...(http ? { http } : {}) });
	return {
		url,
		state: verdict.state,
		detail: verdict.detail,
		httpStatus: http?.outcome === "response" ? http.page.status : null,
		finalUrl: http?.urls.at(-1) ?? null,
		resolvedAddresses: dnsObservation.outcome === "resolved" ? dnsObservation.addresses : [],
		domainStatuses: statuses,
		checkedAt,
	};
}
