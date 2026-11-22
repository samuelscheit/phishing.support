import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { hostingAddress, hostingAddressLine } from "../mail/draft";
import { HISTORICAL_ADDRESS_MAX_AGE_DAYS, originHostAddress, originHostSnapshotSchema, readOriginHostSnapshot, type OriginHostSnapshot } from "./snapshot";

const certificate = { names: ["trk.kit.run"], notBefore: "2026-11-01T00:00:00.000Z", notAfter: "2027-01-30T00:00:00.000Z", issuer: "C=US, O=Let's Encrypt, CN=R11", fingerprint256: "AA" };
const OBSERVED = "2026-11-22T06:00:00.000Z";
const daysBefore = (days: number) => new Date(Date.parse(OBSERVED) - days * 86_400_000).toISOString();
const resolution = (ip: string, lastSeen: string, host = "trk.kit.run") => ({ host, ip, lastSeen, sources: ["virustotal" as const], asn: 14061, prefix: "8.8.8.0/24" });

function snapshot(overrides: Partial<OriginHostSnapshot> = {}): OriginHostSnapshot {
	return originHostSnapshotSchema.parse({
		kind: "cloudflare_origin_host",
		version: 3,
		recipient: "abuse@digitalocean.com",
		providerLabel: "DigitalOcean",
		originalDomain: "trk.kit.run",
		sourceMessageId: "1",
		observedAt: OBSERVED,
		networks: [{ asn: 14061, holder: "DIGITALOCEAN-ASN", prefixes: ["8.8.8.0/24"], discoverySources: ["registry_name_search"] }],
		scan: { addressesScanned: 256, totalAddresses: 256, truncated: false, selectedPrefixes: [{ asn: 14061, prefix: "8.8.8.0/24" }], completedAt: OBSERVED },
		servers: [],
		dnsHistory: { hosts: ["trk.kit.run", "kit.run", "www.kit.run"], sources: ["virustotal"], recordsFound: 3 },
		historicalResolutions: [],
		kit: { collects: [], exfiltrationProbed: false, exfiltrationTargets: [] },
		fingerprints: [],
		siblingCandidateCount: 0,
		siblings: [],
		errors: [],
		...overrides,
	});
}

const route = (value: OriginHostSnapshot) => ({ providerDisplayName: "DigitalOcean", resolutionSnapshot: value, resolverProvenance: { source: "cloudflare_origin_disclosure" }, createdAt: new Date(OBSERVED) });
const domainTarget = { normalizedTarget: "trk.kit.run", targetType: "domain" as const };

describe("the origin host's address", () => {
	test("a verified server wins over any history", () => {
		const value = snapshot({
			servers: [{ ip: "8.8.8.9", certificate, discovery: "tls_sweep" }],
			historicalResolutions: [resolution("8.8.8.2", daysBefore(1))],
		});
		expect(originHostAddress(value)).toEqual({ verified: true, ip: "8.8.8.9" });
		expect(hostingAddress(route(value), domainTarget)).toBe("8.8.8.9");
		expect(hostingAddressLine(route(value))).toBe("Hosting: trk.kit.run is behind Cloudflare, and Cloudflare named abuse@digitalocean.com as its host. Origin server 8.8.8.9:443 returned byte-identical captured files and presents trk.kit.run's certificate.");
	});

	test("a server found in the DNS history says so", () => {
		const value = snapshot({ servers: [{ ip: "8.8.8.9", certificate, discovery: "dns_history" }] });
		expect(hostingAddressLine(route(value))).toContain("Origin server 8.8.8.9:443, found through the domain's DNS history, returned byte-identical captured files");
	});

	test("without one, the domain's own most recent in-network address stands in up to the age limit", () => {
		const atLimit = snapshot({ historicalResolutions: [resolution("8.8.8.1", daysBefore(HISTORICAL_ADDRESS_MAX_AGE_DAYS)), resolution("8.8.8.2", daysBefore(20))] });
		expect(originHostAddress(atLimit)).toMatchObject({ verified: false, ip: "8.8.8.1" });
		expect(hostingAddress(route(atLimit), domainTarget)).toBe("8.8.8.1");
		expect(hostingAddressLine(route(atLimit))).toBe(`Hosting: trk.kit.run is behind Cloudflare, and Cloudflare named abuse@digitalocean.com as its host. Historical address, unverified: before Cloudflare, trk.kit.run resolved to 8.8.8.1 in this host's network, last seen ${daysBefore(HISTORICAL_ADDRESS_MAX_AGE_DAYS).slice(0, 10)} (passive DNS, VirusTotal); it no longer serves the site, so please check which customer held it then.`);

		const newest = snapshot({ historicalResolutions: [resolution("8.8.8.1", daysBefore(5)), resolution("8.8.8.3", daysBefore(1)), resolution("8.8.8.4", "2026-11-23T00:00:00.000Z")] });
		expect(originHostAddress(newest)?.ip).toBe("8.8.8.4");
	});

	test("an address past the limit, or only the parent site's, is not given as the site's", () => {
		const stale = snapshot({ historicalResolutions: [resolution("8.8.8.1", daysBefore(HISTORICAL_ADDRESS_MAX_AGE_DAYS + 0.001))] });
		expect(originHostAddress(stale)).toBeUndefined();
		expect(hostingAddress(route(stale), domainTarget)).toBeUndefined();
		expect(hostingAddressLine(route(stale))).toBe("Hosting: trk.kit.run is behind Cloudflare, and Cloudflare named abuse@digitalocean.com as its host.");

		const parent = snapshot({ historicalResolutions: [resolution("8.8.8.1", daysBefore(1), "kit.run"), resolution("8.8.8.2", daysBefore(1), "www.kit.run")] });
		expect(originHostAddress(parent)).toBeUndefined();
	});

	test("an address target is its own address", () => {
		expect(hostingAddress(route(snapshot()), { normalizedTarget: "8.8.8.7", targetType: "ip" })).toBe("8.8.8.7");
	});

	test("the schema refuses a server without its discovery and history without a source", () => {
		const value = snapshot();
		expect(originHostSnapshotSchema.safeParse({ ...value, servers: [{ ip: "8.8.8.9", certificate }] }).success).toBeFalse();
		expect(originHostSnapshotSchema.safeParse({ ...value, historicalResolutions: [{ ...resolution("8.8.8.1", OBSERVED), sources: [] }] }).success).toBeFalse();
		expect(originHostSnapshotSchema.safeParse({ ...value, version: 2 }).success).toBeFalse();
	});
});

describe("migration of stored version 2 snapshots", () => {
	test("every server becomes a swept one, with no DNS history consulted, and the snapshot reads as version 3", () => {
		const { dnsHistory: _dnsHistory, historicalResolutions: _historicalResolutions, ...current } = snapshot();
		const v2 = { ...current, version: 2, servers: [{ ip: "8.8.8.9", asn: 14061, prefix: "8.8.8.0/24", certificate }, { ip: "8.8.8.10", certificate }] };
		const empty = { ...current, version: 2, servers: [] };
		const db = new Database(":memory:");
		db.run("CREATE TABLE abuse_provider_routes (id INTEGER PRIMARY KEY, resolution_snapshot TEXT NOT NULL)");
		db.run("CREATE TABLE abuse_targets (id INTEGER PRIMARY KEY, resolver_snapshot TEXT)");
		const routes = db.query("INSERT INTO abuse_provider_routes VALUES (?, ?)");
		routes.run(1, JSON.stringify(v2));
		routes.run(2, JSON.stringify(empty));
		routes.run(3, JSON.stringify({ kind: "other", version: 2, servers: [{ ip: "1.1.1.1" }] }));
		const targets = db.query("INSERT INTO abuse_targets VALUES (?, ?)");
		targets.run(1, JSON.stringify(v2));
		targets.run(2, null);
		targets.run(3, "not json");

		const sql = readFileSync(path.join(import.meta.dir, "../../../../drizzle/0027_origin_snapshot_v3.sql"), "utf8");
		for (const statement of sql.split("--> statement-breakpoint")) db.run(statement);

		const read = (table: string, column: string, id: number) => (db.query(`SELECT ${column} AS value FROM ${table} WHERE id = ?`).get(id) as { value: string | null }).value;
		const migrated = readOriginHostSnapshot(JSON.parse(read("abuse_provider_routes", "resolution_snapshot", 1)!));
		expect(migrated).toEqual({
			...current,
			version: 3,
			servers: [{ ip: "8.8.8.9", asn: 14061, prefix: "8.8.8.0/24", certificate, discovery: "tls_sweep" }, { ip: "8.8.8.10", certificate, discovery: "tls_sweep" }],
			dnsHistory: { hosts: [], sources: [], recordsFound: 0 },
			historicalResolutions: [],
		});
		expect(readOriginHostSnapshot(JSON.parse(read("abuse_provider_routes", "resolution_snapshot", 2)!))?.servers).toEqual([]);
		expect(JSON.parse(read("abuse_provider_routes", "resolution_snapshot", 3)!)).toEqual({ kind: "other", version: 2, servers: [{ ip: "1.1.1.1" }] });
		expect(readOriginHostSnapshot(JSON.parse(read("abuse_targets", "resolver_snapshot", 1)!))).toEqual(migrated);
		expect(read("abuse_targets", "resolver_snapshot", 2)).toBeNull();
		expect(read("abuse_targets", "resolver_snapshot", 3)).toBe("not json");
	});
});
