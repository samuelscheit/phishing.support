import type { NetworkLookup } from "./hosting";

/** The infrastructure part of trylevo.app's resolver snapshot as stored in production (report 384415530104131612). */
export const TRYLEVO_ROUTED_SNAPSHOT = {
	target: "trylevo.app",
	registeredDomain: "trylevo.app",
	infrastructure: {
		dns: { source: "dns", publicAddresses: ["188.114.96.2", "188.114.97.2"], records: { A: { addresses: ["188.114.96.2", "188.114.97.2"] } } },
		ipResolutions: ["188.114.96.2", "188.114.97.2"].map((ip) => ({
			ip,
			status: "resolved",
			resolverSnapshot: {
				target: ip,
				allocationOwner: { handle: "188.114.96.0 - 188.114.99.255", name: "CLOUDFLARENET-EU", organization: "CLOUDFLARENET-EU", roles: [] },
				bgpOrigin: { prefix: `${ip.replace(/\.\d+$/, ".0")}/24`, asns: [13335] },
				asnRdap: [{ asn: 13335, organization: { handle: "CLOUD14", name: "Cloudflare, Inc.", organization: "Cloudflare, Inc.", roles: ["registrant"] } }],
			},
		})),
	},
};

/** RIPEstat's answers of 2026-11-26 for the addresses these tests use. */
export const NETWORKS: Record<string, Awaited<ReturnType<NetworkLookup>>> = {
	"85.137.52.128": { asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o.", prefix: "85.137.52.0/24" },
	"85.137.52.130": { asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o.", prefix: "85.137.52.0/24" },
	"188.114.96.3": { asn: 13335, holder: "CLOUDFLARENET - Cloudflare, Inc., US", prefix: "188.114.96.0/24" },
	"104.21.32.1": { asn: 13335, holder: "CLOUDFLARENET - Cloudflare, Inc., US", prefix: "104.21.32.0/20" },
	"151.101.1.195": { asn: 54113, holder: "FASTLY - Fastly, Inc., US", prefix: "151.101.0.0/22" },
	"5.161.1.1": { asn: 213230, holder: "HETZNER-CLOUD2-AS Hetzner Online GmbH", prefix: "5.161.0.0/16" },
	"88.198.1.1": { asn: 24940, holder: "HETZNER-AS Hetzner Online GmbH", prefix: "88.198.0.0/16" },
	// al-tawaqal-poultry-farm.pro (report 382516419029373121) between 21 and 24 Nov 2026.
	"147.90.13.47": { asn: 57043, holder: "HOSTKEY-AS HOSTKEY B.V.", prefix: "147.90.13.0/24" },
	"153.75.235.103": { asn: 26666, holder: "INTERSERVER-LAX - Interserver, Inc", prefix: "153.75.232.0/22" },
	"23.215.0.136": { asn: 20940, holder: "AKAMAI-ASN1 - Akamai International B.V., NL", prefix: "23.215.0.0/24" },
	"2.16.1.1": { asn: 16625, holder: "AKAMAI-AS - Akamai Technologies, Inc., US", prefix: "2.16.0.0/16" },
	"34.120.1.1": { asn: 396982, holder: "GOOGLE-CLOUD-PLATFORM - Google LLC, US", prefix: "34.120.0.0/16" },
	"76.76.21.21": { asn: 16509, holder: "AMAZON-02 - Amazon.com, Inc., US", prefix: "76.76.21.0/24" },
};

export function networkLookup(asked: string[] = []): NetworkLookup {
	return async (ip) => {
		asked.push(ip);
		const network = NETWORKS[ip];
		if (!network) throw new Error(`RIPEstat has no answer for ${ip}`);
		return network;
	};
}

