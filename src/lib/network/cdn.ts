/**
 * Networks that proxy sites rather than host them: an address in one says
 * nothing about where the site's server is. Only networks that front sites
 * for their customers are listed. Amazon CloudFront shares AS16509 with EC2
 * and is told apart by its answer instead (`cdnOfServer`), as are Vercel
 * and Netlify, which serve from such shared networks too.
 */
const CDN_NETWORKS: ReadonlyArray<{ name: string; asns: readonly number[]; hosting?: true }> = [
	{ name: "Cloudflare", asns: [13335, 209242] },
	{ name: "Fastly", asns: [54113] },
	// Akamai announces its edge from many networks (Akamai Technologies, Akamai International, its regional networks).
	{ name: "Akamai", asns: [12222, 16625, 16702, 17204, 18680, 18717, 20189, 20940, 21342, 21357, 21399, 22207, 22452, 23454, 23455, 23903, 24319, 26008, 30675, 31107, 31108, 31109, 31110, 31377, 33047, 33905, 34164, 34850, 35204, 35993, 35994, 36183, 39836, 43639, 55409, 55770] },
	// Google's and Microsoft's front ends (Firebase Hosting, Cloud CDN, Blogger, Sites; Azure Front Door, Azure CDN)
	// share their networks with the companies' own hosting: an address there names the company, which also hosts.
	{ name: "Google", asns: [15169, 396982], hosting: true },
	{ name: "Microsoft", asns: [8075], hosting: true },
	{ name: "bunny.net", asns: [200325] },
	{ name: "DDoS-Guard", asns: [57724] },
	{ name: "Imperva", asns: [19551] },
	{ name: "Sucuri", asns: [30148] },
	{ name: "StackPath", asns: [20446, 33438] },
];

const EDGE_BY_ASN: ReadonlyMap<number, { name: string; hosting: boolean }> = new Map(CDN_NETWORKS.flatMap(({ name, asns, hosting }) => asns.map((asn) => [asn, { name, hosting: hosting ?? false }] as const)));

/** The CDN an autonomous system belongs to, when the network only proxies: its address says nothing about where the origin is. */
export function cdnOfAsn(asn: number | undefined): string | undefined {
	const edge = asn === undefined ? undefined : EDGE_BY_ASN.get(asn);
	return edge && !edge.hosting ? edge.name : undefined;
}

/** The edge network a site is served through, by name: a CDN, or a cloud's front ends that also host. */
export function edgeOfAsn(asn: number | undefined): string | undefined {
	return asn === undefined ? undefined : EDGE_BY_ASN.get(asn)?.name;
}

/** Platforms that front sites from networks they share with others, named by the `Server` header they answer with. */
const CDN_SERVERS: ReadonlyArray<[RegExp, string]> = [
	[/^cloudfront$/i, "Amazon CloudFront"],
	[/^vercel$/i, "Vercel"],
	[/^netlify$/i, "Netlify"],
];

/** The platform that answered for a site, by its `Server` header; undefined for an origin server. */
export function cdnOfServer(server: string | undefined): string | undefined {
	const name = server?.trim();
	return name ? CDN_SERVERS.find(([pattern]) => pattern.test(name))?.[1] : undefined;
}
