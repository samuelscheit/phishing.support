import type { ResolvedRouteInput } from "../route_contracts";
import type { AbuseTargetType } from "../schema";
import type { RdapLocator } from "../../network/rdap_bootstrap";

import type { JsonRecord } from "../../util/values";
import { type FetchLike } from "../../http/fetch";

export type { JsonRecord };

export type ResolverDependencies = {
	/** Injectable for deterministic resolver tests. Production uses global fetch. */
	fetch?: FetchLike;
	/** Bounds each HTTP response, including body reads. Production defaults to 12 seconds. */
	httpTimeoutMs?: number;
	/** Number of bounded RDAP/RIPE HTTP attempts. Defaults to two. */
	httpRetryAttempts?: number;
	/** Bounds each authoritative port-43 WHOIS attempt. Production defaults to 12 seconds. */
	port43TimeoutMs?: number;
	/** Number of bounded authoritative port-43 WHOIS attempts. Production defaults to two. */
	port43Attempts?: number;
	/** Injectable because authoritative port-43 services cannot be used in unit tests. */
	port43Query?: (server: string, query: string) => Promise<string>;
	/** Injectable SSRF guard for deterministic tests. Production resolves every host. */
	assertPublicHost?: (hostname: string) => Promise<void>;
	/** Injectable A/AAAA lookup used to discover hosting-network abuse routes for a domain. */
	resolveDomainAddresses?: (domain: string) => Promise<string[]>;
	/** Finds the authoritative RDAP server. Production reads IANA's bootstrap registries. */
	rdapLocator?: RdapLocator;
};

export type ResolverTarget = {
	normalizedTarget: string;
	targetType: AbuseTargetType;
	observedUrls: string[];
};

export type ResolvedAbuseTarget = {
	status: "resolved" | "no_route" | "failed";
	disposition?: string;
	resolverSnapshot: JsonRecord;
	routes: ResolvedRouteInput[];
	/**
	 * Lookups that failed rather than finding nothing (an HTTP 429, a timeout,
	 * a server error). A route they would have found may be missing, so the
	 * resolution is worth repeating.
	 */
	lookupFailures?: string[];
};

export type AbuseMailbox = {
	email: string;
	source: "registrar_rdap" | "domain_rdap" | "domain_whois" | "ip_rdap" | "ip_whois" | "parent_ip_rdap" | "asn_rdap" | "upstream_asn_rdap";
	entityHandle?: string;
	entityName?: string;
	roles?: string[];
	/** The organization that publishes the mailbox, when its record names one (an ASN's holder). */
	organization?: string;
	/** For an upstream's mailbox: whose traffic it carries. */
	transit?: TransitRelation;
};

/** An upstream reached because its customer network's own abuse contacts failed. */
type TransitRelation = {
	upstreamAsn: number;
	customerAsn: number;
	customerOrganization?: string;
	/** The announced prefix that holds the reported address. */
	customerPrefix?: string;
};
