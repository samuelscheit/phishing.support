/**
 * Networks that proxy sites rather than host them: an address in one says
 * nothing about where the site's server is. Only networks whose whole
 * address space is the proxy are listed; Amazon CloudFront shares AS16509
 * with EC2 and cannot be told apart by its network.
 */
const CDN_NETWORKS: ReadonlyArray<{ name: string; asns: readonly number[] }> = [
	{ name: "Cloudflare", asns: [13335, 209242] },
	{ name: "Fastly", asns: [54113] },
	{ name: "Akamai", asns: [20940, 16625] },
	{ name: "bunny.net", asns: [200325] },
	{ name: "DDoS-Guard", asns: [57724] },
	{ name: "Imperva", asns: [19551] },
	{ name: "Sucuri", asns: [30148] },
	{ name: "StackPath", asns: [20446, 33438] },
];

const CDN_BY_ASN: ReadonlyMap<number, string> = new Map(CDN_NETWORKS.flatMap(({ name, asns }) => asns.map((asn) => [asn, name] as const)));

/** The CDN an autonomous system belongs to, by name; undefined for any other network. */
export function cdnOfAsn(asn: number | undefined): string | undefined {
	return asn === undefined ? undefined : CDN_BY_ASN.get(asn);
}
