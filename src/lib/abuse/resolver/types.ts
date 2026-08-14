import type { ResolvedRouteInput } from "../route_contracts";

export type JsonRecord = Record<string, unknown>;

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ResolverDependencies = {
	/** Injectable for deterministic resolver tests. Production uses global fetch. */
	fetch?: FetchImplementation;
	/** Bounds each HTTP response, including body reads. Production defaults to 12 seconds. */
	httpTimeoutMs?: number;
	/** Injectable because authoritative port-43 services cannot be used in unit tests. */
	port43Query?: (server: string, query: string) => Promise<string>;
	/** Injectable SSRF guard for deterministic tests. Production resolves every host. */
	assertPublicHost?: (hostname: string) => Promise<void>;
	/** Injectable A/AAAA lookup used to discover hosting-network abuse routes for a domain. */
	resolveDomainAddresses?: (domain: string) => Promise<string[]>;
};

export type ResolverTarget = {
	normalizedTarget: string;
	targetType: "domain" | "ip";
	observedUrls: string[];
};

export type ResolvedAbuseTarget = {
	status: "resolved" | "no_route" | "failed";
	disposition?: string;
	resolverSnapshot: JsonRecord;
	routes: ResolvedRouteInput[];
};

export type AbuseMailbox = {
	email: string;
	source: "domain_rdap" | "domain_whois" | "ip_rdap" | "ip_whois" | "asn_rdap";
	entityHandle?: string;
	entityName?: string;
	roles?: string[];
};
