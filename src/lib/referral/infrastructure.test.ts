import { describe, expect, test } from "bun:test";

import { countryRoutes, directComplaint } from "./countries";
import { indicatorInfrastructure, infrastructureLines, locateInfrastructure, mergeInfrastructure, routeInfrastructure, type CountryLookup, type InfrastructureClaim } from "./infrastructure";

type Route = Parameters<typeof routeInfrastructure>[0];

const route = (overrides: Partial<Route>): Route => ({
	providerRegistryKey: "email:example.net",
	providerDisplayName: "Abuse-C Role",
	verifiedEmail: null,
	resolverProvenance: {},
	resolutionSnapshot: {},
	...overrides,
});

// Shapes as production stores them (abuse_provider_routes, 2026-11).
const cloudflare = route({ providerRegistryKey: "cloudflare", providerDisplayName: "Cloudflare Abuse", resolverProvenance: { source: "domain_infrastructure_ip" }, resolutionSnapshot: { target: "shop.example", infrastructureIp: "104.21.20.135" } });
const cryphora = route({
	providerRegistryKey: "origin-host-email",
	providerDisplayName: "CRYPHORA-AS - Cryphora Limited, GB",
	verifiedEmail: "abuse@cryphora.net",
	resolverProvenance: { source: "cloudflare_origin_disclosure" },
	resolutionSnapshot: { kind: "cloudflare_origin_host", providerLabel: "CRYPHORA-AS - Cryphora Limited, GB", networks: [{ asn: 214940, holder: "CRYPHORA-AS - Cryphora Limited, GB", prefixes: [] }] },
});
const interserver = route({
	providerRegistryKey: "origin-host-email",
	providerDisplayName: "Interserver, Inc",
	verifiedEmail: "abusencc@interserver.net",
	resolverProvenance: { source: "cloudflare_origin_disclosure" },
	resolutionSnapshot: { providerLabel: "Interserver, Inc", networks: [{ asn: 19318, holder: "IS-AS-1 - Interserver, Inc" }] },
});
const hostingerRegistrar = route({
	providerRegistryKey: "email:hostinger.com",
	providerDisplayName: "Abuse team",
	verifiedEmail: "abuse@hostinger.com",
	resolverProvenance: { source: "domain_rdap" },
	resolutionSnapshot: { registrar: { id: 1636, identity: { name: "HOSTINGER operations, UAB" } } },
});
const hostingerHosting = route({
	providerRegistryKey: "email:hostinger.com",
	providerDisplayName: "Abuse team",
	verifiedEmail: "abuse@hostinger.com",
	resolverProvenance: { source: "domain_infrastructure_ip" },
	resolutionSnapshot: { infrastructureIp: "2.57.91.10", ipResolution: { target: "2.57.91.10", allocationOwner: { name: "HOSTINGER-HOSTING" }, ipRdap: { data: { country: "LT" } } } },
});
const cloudzy = route({
	providerRegistryKey: "email:cloudzy.com",
	verifiedEmail: "aler@cloudzy.com",
	resolverProvenance: { source: "ip_rdap" },
	resolutionSnapshot: { target: "153.75.90.37", allocationOwner: { name: "AE-CLOUDZY-19910923" }, ipRdap: { data: { country: "AE" } } },
});

function fakeLookup(registered: Record<string, string>, located: Record<string, string>) {
	const asked: string[] = [];
	const lookup: CountryLookup = {
		registered: async (resource) => (asked.push(`registered:${resource}`), registered[resource]),
		located: async (ip) => (asked.push(`located:${ip}`), located[ip]),
	};
	return { lookup, asked };
}

describe("routeInfrastructure", () => {
	test("warning services hold no records and are left out", () => {
		for (const key of ["netcraft", "netcraft_mail", "google_safe_browsing", "historical:google_safe_browsing", "manual_unroutable"]) {
			expect(routeInfrastructure(route({ providerRegistryKey: key }))).toBeUndefined();
		}
	});

	test("Cloudflare is the CDN, not the host", () => {
		expect(routeInfrastructure(cloudflare)).toEqual({ role: "cdn", name: "Cloudflare", resources: [] });
	});

	test("the host Cloudflare disclosed carries its AS and the country in RIPEstat's holder", () => {
		expect(routeInfrastructure(cryphora)).toEqual({ role: "hosting", name: "CRYPHORA-AS - Cryphora Limited, GB", resources: ["AS214940"], networkCountry: "GB", contact: "abuse@cryphora.net" });
		// ARIN holders name no country; it is looked up later.
		expect(routeInfrastructure(interserver)).toEqual({ role: "hosting", name: "Interserver, Inc", resources: ["AS19318"], contact: "abusencc@interserver.net" });
	});

	test("a registrar is named by its RDAP identity, a network by mailbox and network name", () => {
		expect(routeInfrastructure(hostingerRegistrar)).toMatchObject({ role: "registrar", name: "HOSTINGER operations, UAB" });
		expect(routeInfrastructure(cloudzy)).toEqual({ role: "hosting", name: "cloudzy.com (AE-CLOUDZY-19910923)", resources: ["153.75.90.37"], networkCountry: "AE", contact: "aler@cloudzy.com" });
	});

	test("a manually found origin keeps the holder and AS the operator recorded", () => {
		const informaten = route({
			verifiedEmail: "abuse@informaten.com",
			resolverProvenance: { source: "ripe_abuse_c" },
			resolutionSnapshot: { target: "195.234.126.108", network: { asn: 203029, asName: "INFORMATEN", holder: "Alec Putzmann trading as Informaten GbR" } },
		});
		expect(routeInfrastructure(informaten)).toEqual({ role: "hosting", name: "Alec Putzmann trading as Informaten GbR", resources: ["195.234.126.108", "AS203029"], contact: "abuse@informaten.com" });
	});

	test("a webhook account is where the entered data goes", () => {
		expect(routeInfrastructure(route({ providerRegistryKey: "discord_webhook", providerDisplayName: "Discord webhook deletion" }))?.role).toBe("exfiltration");
		expect(routeInfrastructure(route({ providerRegistryKey: "email:discord.com", providerDisplayName: "Discord Trust & Safety", resolverProvenance: { source: "service_account_registry" } }))?.role).toBe("exfiltration");
	});

	test("a route of unknown provenance stays a provider without a role", () => {
		expect(routeInfrastructure(route({ resolverProvenance: { source: "migrated_legacy_provider_report" }, providerDisplayName: "abuse@legacy.example" }))).toEqual({ role: "provider", name: "abuse@legacy.example", resources: [] });
	});
});

describe("indicatorInfrastructure", () => {
	test("exfiltration services and the IBAN's country", () => {
		expect(indicatorInfrastructure({ kind: "exfiltration_backend", value: "telegram-bot:7001", evidence: { backendKind: "telegram_bot" } })).toEqual({ role: "exfiltration", name: "Telegram", resources: [] });
		expect(indicatorInfrastructure({ kind: "exfiltration_backend", value: "collector-host:api.bitflowpay.com", evidence: { backendKind: "domain" } })).toEqual({ role: "exfiltration", name: "api.bitflowpay.com", resources: [] });
		expect(indicatorInfrastructure({ kind: "payment_receiver", value: "iban:LT121000011101001000", evidence: { receiverKind: "iban", receiver: "LT121000011101001000" } }))
			.toEqual({ role: "payment", name: "IBAN LT121000011101001000", resources: [], networkCountry: "LT" });
		// A wallet has no state.
		expect(indicatorInfrastructure({ kind: "payment_receiver", value: "bitcoin:bc1q", evidence: { receiverKind: "bitcoin", receiver: "bc1q" } })).toBeUndefined();
		expect(indicatorInfrastructure({ kind: "kit_fingerprint", value: "ab", evidence: {} })).toBeUndefined();
	});
});

const claim = (value: Route): InfrastructureClaim => routeInfrastructure(value)!;

describe("mergeInfrastructure", () => {
	test("one host under two spellings is one node, merged by its AS; registry escapes are undone", () => {
		const short = route({ ...cryphora, providerDisplayName: "Cryphora Limited", resolutionSnapshot: { providerLabel: "Cryphora Limited", networks: [{ asn: 214940, holder: "CRYPHORA-AS - Cryphora Limited, GB" }] } });
		const skn = route({ ...cryphora, verifiedEmail: "abuse@skntelecom.com", resolutionSnapshot: { providerLabel: "SKN-NETWORK-1 - SKN Subnet &amp; Telecom Ltd, KN", networks: [{ asn: 64500 }] } });
		const nodes = mergeInfrastructure([
			{ site: "https://a.example/", claim: claim(cryphora) },
			{ site: "https://b.example/", claim: claim(short) },
			{ site: "https://c.example/", claim: claim(skn) },
		]);
		expect(nodes.map((node) => [node.name, node.country, node.sites.length])).toEqual([
			["CRYPHORA-AS - Cryphora Limited, GB", "GB", 2],
			["SKN-NETWORK-1 - SKN Subnet & Telecom Ltd, KN", "KN", 1],
		]);
	});

	test("one node per role and record holder, across sites and mailboxes", () => {
		const nodes = mergeInfrastructure([
			{ site: "https://a.example/", claim: claim(cryphora) },
			{ site: "https://b.example/", claim: claim(cryphora) },
			{ site: "https://a.example/", claim: claim(cloudflare) },
			{ site: "https://a.example/", claim: claim(hostingerRegistrar) },
			{ site: "https://a.example/", claim: claim(hostingerHosting) },
		]);
		expect(nodes.map((node) => [node.role, node.name, node.country, node.sites.length])).toEqual([
			["hosting", "CRYPHORA-AS - Cryphora Limited, GB", "GB", 2],
			// The record holder decides the state, not the network: Hostinger's EU customers contract in Cyprus.
			["hosting", "Hostinger International Ltd, Larnaca (contracting party for customers in the EU)", "CY", 1],
			["cdn", "Cloudflare, Inc.", "US", 1],
			["registrar", "HOSTINGER operations, UAB (registrar)", "LT", 1],
		]);
		expect(nodes[1]!.networkCountry).toBe("LT");
	});
});

describe("locateInfrastructure", () => {
	test("looks up only what the records lack, and never locates a CDN", async () => {
		const { lookup, asked } = fakeLookup({ AS19318: "US" }, { "153.75.90.37": "NL" });
		const nodes = await locateInfrastructure(mergeInfrastructure([
			{ site: "https://a.example/", claim: claim(interserver) },
			{ site: "https://a.example/", claim: claim(cloudzy) },
			{ site: "https://a.example/", claim: { role: "cdn", name: "Cloudflare", resources: ["104.21.20.135"] } },
		]), lookup);
		expect(asked.sort()).toEqual(["located:153.75.90.37", "registered:104.21.20.135", "registered:AS19318"]);
		const byName = new Map(nodes.map((node) => [node.name, node]));
		expect(byName.get("Interserver, Inc")).toMatchObject({ networkCountry: "US", country: "US" });
		expect(byName.get("Interserver, Inc")!.serverCountry).toBeUndefined();
		expect(byName.get("cloudzy.com (AE-CLOUDZY-19910923)")).toMatchObject({ networkCountry: "AE", serverCountry: "NL", country: "AE" });
		expect(byName.get("Cloudflare, Inc.")!.serverCountry).toBeUndefined();
	});

	test("a failed lookup leaves the state unknown", async () => {
		const [node] = await locateInfrastructure(mergeInfrastructure([{ site: "https://a.example/", claim: claim(interserver) }]), { registered: async () => undefined, located: async () => undefined });
		expect(node!.country).toBeUndefined();
	});
});

describe("infrastructureLines", () => {
	const nodes = mergeInfrastructure([
		{ site: "https://a.example/", claim: claim(hostingerHosting) },
		{ site: "https://a.example/", claim: claim(hostingerRegistrar) },
		{ site: "https://a.example/", claim: { role: "exfiltration", name: "api.bitflowpay.com", resources: [] } },
	]);

	test("groups by state with that state's instruments; unknown states come last", () => {
		const lines = infrastructureLines(nodes, "de");
		expect(lines[0]).toBe("Zypern (CY):");
		expect(lines).toContain(`  ${countryRoutes("CY")[0]!.de}`);
		expect(lines.some((line) => line.startsWith("  - Hoster: Hostinger International Ltd, Larnaka") && line.includes("Netz registriert in Litauen") && line.includes("Abuse-Kontakt abuse@hostinger.com"))).toBe(true);
		expect(lines).toContain(`  Eigene Anzeige vor Ort möglich: ${directComplaint("LT")!.de}`);
		expect(lines.at(-2)).toBe("Staat nicht ermittelt:");
		expect(lines.at(-1)).toBe("  - Empfänger der Eingaben: api.bitflowpay.com (1 Seite)");
	});

	test("speaks English for the archive", () => {
		const lines = infrastructureLines(nodes, "en");
		expect(lines[0]).toBe("Cyprus (CY):");
		expect(lines.at(-2)).toBe("State not determined:");
	});
});

describe("countryRoutes", () => {
	const de = (code: string) => countryRoutes(code).map((route) => route.de).join("\n");

	test("an EU state gets the production order, never a preservation order Germany cannot issue", () => {
		expect(de("NL")).toContain("Europäische Herausgabeanordnung");
		expect(de("NL")).toContain("Sicherungsanordnung kann Deutschland derzeit nicht erlassen");
		expect(de("NL")).toContain("24/7-Kontaktstelle des BKA");
		// Denmark is not bound by the e-Evidence Regulation.
		expect(de("DK")).not.toContain("Herausgabeanordnung");
		// Ireland has only signed the Budapest Convention.
		expect(de("IE")).not.toContain("24/7-Kontaktstelle des BKA");
	});

	test("the US route never presents § 2703(f) as a German request", () => {
		expect(de("US")).toContain("§ 2702(c)(6)");
		expect(de("US")).toContain("nur US-Behörden");
		expect(de("US")).not.toContain("Herausgabeanordnung (VO");
	});

	test("states outside the convention and unchecked states say so", () => {
		expect(de("RU")).toContain("Kein Vertragsstaat");
		expect(de("RU")).toContain("Keine Anzeige mit Namen");
		expect(de("MY")).toBe("Rechtshilfeweg für diesen Staat noch nicht geprüft.");
		expect(de("DE")).toContain("§ 95 StPO");
	});
});
