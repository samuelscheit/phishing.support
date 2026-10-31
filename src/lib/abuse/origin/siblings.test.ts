import { describe, expect, test } from "bun:test";

import type { WebsiteKitResource } from "../../website_types";
import { discoverSiblingDomains, findKitSiblingCandidates, kitFingerprints } from "./siblings";

const hash = (character: string) => character.repeat(64);
const SCRIPT = hash("a");
const STYLE = hash("b");
const LIBRARY = hash("c");

const RESOURCES: WebsiteKitResource[] = [
	{ url: "https://login.example.com/index.js", mimeType: "application/javascript", size: 58_737, sha256: SCRIPT },
	{ url: "https://login.example.com/res/css/style.css?v=4", mimeType: "text/css", size: 14_364, sha256: STYLE },
	{ url: "https://login.example.com/jquery.min.js", mimeType: "application/javascript", size: 90_000, sha256: LIBRARY },
	// Not usable: a third-party host, a tiny loader, an image, a malformed hash, a duplicate.
	{ url: "https://cdn.example.net/kit.js", mimeType: "application/javascript", size: 20_000, sha256: hash("d") },
	{ url: "https://login.example.com/tiny.js", mimeType: "application/javascript", size: 200, sha256: hash("e") },
	{ url: "https://login.example.com/logo.png", mimeType: "image/png", size: 4_000, sha256: hash("f") },
	{ url: "https://login.example.com/bad.js", mimeType: "application/javascript", size: 4_000, sha256: "not-a-hash" },
	{ url: "https://login.example.com/index.js?again", mimeType: "application/javascript", size: 58_737, sha256: SCRIPT },
];

/** urlscan answers per hash; `domains` lists the distinct page domains it returns. */
function urlscan(domainsByHash: Record<string, string[]>) {
	const queries: URL[] = [];
	const fetch = async (url: string) => {
		const requested = new URL(url);
		queries.push(requested);
		const hashQuery = requested.searchParams.get("q")!.match(/^hash:([a-f0-9]{64})/)![1]!;
		const size = Number(requested.searchParams.get("size"));
		const domains = (domainsByHash[hashQuery] ?? []).slice(0, size);
		return new Response(JSON.stringify({ results: domains.map((domain) => ({ page: { domain, url: `https://${domain}/signin` } })) }), { status: 200 });
	};
	return { fetch, queries };
}

const manyDomains = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}-${index}.example.org`);

describe("kit sibling discovery", () => {
	test("fingerprints only the captured host's own scripts and stylesheets, scripts first", () => {
		expect(kitFingerprints(RESOURCES, "login.example.com")).toEqual([
			{ sha256: LIBRARY, mimeType: "application/javascript", url: "https://login.example.com/jquery.min.js", size: 90_000 },
			{ sha256: SCRIPT, mimeType: "application/javascript", url: "https://login.example.com/index.js", size: 58_737 },
			{ sha256: STYLE, mimeType: "text/css", url: "https://login.example.com/res/css/style.css?v=4", size: 14_364 },
		]);
	});

	test("skips widely shared files and requires a shared script", async () => {
		const { fetch, queries } = urlscan({
			[SCRIPT]: ["login.example.com", "sibling.example.net", "other-kit.example.net"],
			// The stylesheet alone links an unrelated template site; it must not become a candidate.
			[STYLE]: ["login.example.com", "sibling.example.net", "template-only.example.net"],
			// A library on 26+ domains is not one operator's kit.
			[LIBRARY]: ["login.example.com", ...manyDomains(30, "library-user")],
		});
		const result = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitResources: async () => RESOURCES,
			fetch,
		});
		expect(queries.map((query) => query.searchParams.get("size"))).toEqual(["26", "26", "26"]);
		expect(queries[0]!.searchParams.get("collapse")).toBe("page.domain.keyword");
		expect(result.candidates).toEqual([
			{ domain: "sibling.example.net", url: "https://sibling.example.net/signin", matchingHashes: [SCRIPT, STYLE] },
			{ domain: "other-kit.example.net", url: "https://other-kit.example.net/signin", matchingHashes: [SCRIPT] },
		]);
		expect(result.errors).toEqual([`urlscan ${LIBRARY.slice(0, 12)}: seen on more than 25 domains, treated as a shared library`]);
	});

	test("does not search at all without a captured script", async () => {
		const { fetch, queries } = urlscan({ [STYLE]: ["sibling.example.net"] });
		const stylesOnly = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitResources: async () => RESOURCES.filter(({ mimeType }) => mimeType === "text/css"),
			fetch,
		});
		expect(stylesOnly.candidates).toEqual([]);
		const legacy = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitResources: async () => undefined,
			fetch,
		});
		expect(legacy).toEqual({ fingerprints: [], candidates: [], errors: ["The capture recorded no same-host scripts or stylesheets."] });
		expect(queries).toHaveLength(0);
	});

	test("accepts a candidate only when the swept origin presents its certificate", async () => {
		const { fetch } = urlscan({ [SCRIPT]: ["sibling.example.net", "unrelated.example.org"] });
		const result = await discoverSiblingDomains({
			submissionId: 1n,
			originalDomain: "login.example.com",
			originServers: [{ ip: "8.8.8.8", certificate: { names: ["login.example.com"], issuer: "CA", fingerprint256: "AA", notBefore: "2026-01-01", notAfter: "2027-01-01" } }],
		}, {
			apiKey: "secret-test-key",
			loadKitResources: async () => RESOURCES.slice(0, 1),
			fetch,
			probe: async (_ip, domain) => domain === "sibling.example.net"
				? { names: [domain], issuer: "CA", fingerprint256: "BB", notBefore: "2026-01-01", notAfter: "2027-01-01" }
				: { names: ["someone-else.example"], issuer: "CA", fingerprint256: "CC", notBefore: "2026-01-01", notAfter: "2027-01-01" },
		});
		expect(result.candidateCount).toBe(2);
		expect(result.confirmed).toEqual([{
			domain: "sibling.example.net",
			url: "https://sibling.example.net/signin",
			matchingHashes: [SCRIPT],
			originIp: "8.8.8.8",
			certificate: { names: ["sibling.example.net"], issuer: "CA", fingerprint256: "BB", notBefore: "2026-01-01", notAfter: "2027-01-01" },
		}]);
	});
});
