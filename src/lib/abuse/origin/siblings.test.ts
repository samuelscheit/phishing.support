import { describe, expect, test } from "bun:test";

import type { WebsiteKitResource } from "../../website_types";
import { discoverSiblingDomains, findKitSiblingCandidates, kitFingerprints } from "./siblings";

const hash = (character: string) => character.repeat(64);
const SCRIPT = hash("a");
const STYLE = hash("b");
const LIBRARY = hash("c");
const BACKEND_SCRIPT = hash("d");

const RESOURCES: WebsiteKitResource[] = [
	{ url: "https://login.example.com/index.js", mimeType: "application/javascript", size: 58_737, sha256: SCRIPT },
	{ url: "https://login.example.com/res/css/style.css?v=4", mimeType: "text/css", size: 14_364, sha256: STYLE },
	{ url: "https://cdn.example.net/jquery.min.js", mimeType: "application/javascript", size: 90_000, sha256: LIBRARY },
	// A loader kit's real code, served from its backend host.
	{ url: "https://backend.example.net/gmail/js/start.js", mimeType: "application/javascript", size: 3_280, sha256: BACKEND_SCRIPT },
	// Not usable: a tiny loader, an image, a malformed hash, a duplicate.
	{ url: "https://login.example.com/tiny.js", mimeType: "application/javascript", size: 200, sha256: hash("e") },
	{ url: "https://login.example.com/logo.png", mimeType: "image/png", size: 4_000, sha256: hash("f") },
	{ url: "https://login.example.com/bad.js", mimeType: "application/javascript", size: 4_000, sha256: "not-a-hash" },
	{ url: "https://login.example.com/index.js?again", mimeType: "application/javascript", size: 58_737, sha256: SCRIPT },
];

/** urlscan answers per hash; like urlscan, one page holds at most 100 results and `has_more` flags the rest. */
function urlscan(domainsByHash: Record<string, string[]>) {
	const queries: URL[] = [];
	const fetch = async (url: string) => {
		const requested = new URL(url);
		queries.push(requested);
		const hashQuery = requested.searchParams.get("q")!.match(/^hash:([a-f0-9]{64})/)![1]!;
		const size = Math.min(Number(requested.searchParams.get("size")), 100);
		const all = domainsByHash[hashQuery] ?? [];
		const domains = all.slice(0, size);
		return new Response(JSON.stringify({ has_more: all.length > size, results: domains.map((domain) => ({ page: { domain, url: `https://${domain}/signin` } })) }), { status: 200 });
	};
	return { fetch, queries };
}

const manyDomains = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}-${index}.example.org`);

describe("kit sibling discovery", () => {
	test("fingerprints every host's scripts and stylesheets, scripts first", () => {
		expect(kitFingerprints(RESOURCES)).toEqual([
			{ sha256: LIBRARY, mimeType: "application/javascript", url: "https://cdn.example.net/jquery.min.js", size: 90_000 },
			{ sha256: SCRIPT, mimeType: "application/javascript", url: "https://login.example.com/index.js", size: 58_737 },
			{ sha256: BACKEND_SCRIPT, mimeType: "application/javascript", url: "https://backend.example.net/gmail/js/start.js", size: 3_280 },
			{ sha256: STYLE, mimeType: "text/css", url: "https://login.example.com/res/css/style.css?v=4", size: 14_364 },
		]);
	});

	test("finds a loader kit's siblings through its backend script on a shared host", async () => {
		// The Gmail loader on storage.googleapis.com: no own script, its kit lives on the backend.
		const loader: WebsiteKitResource[] = [
			{ url: "https://ajax.googleapis.com/ajax/libs/jquery/3.6.1/jquery.min.js", mimeType: "application/javascript", size: 89_664, sha256: LIBRARY },
			{ url: "https://backend.example.net/gmail/js/start.js", mimeType: "application/javascript", size: 3_280, sha256: BACKEND_SCRIPT },
		];
		const frontPages = manyDomains(39, "front-page");
		const { fetch } = urlscan({
			[LIBRARY]: manyDomains(500, "jquery-user"),
			[BACKEND_SCRIPT]: ["storage.googleapis.com", ...frontPages],
		});
		const result = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "storage.googleapis.com" }, {
			apiKey: "test-key",
			loadKitResources: async () => loader,
			fetch,
		});
		expect(result.candidates.map(({ domain }) => domain)).toEqual(frontPages);
		expect(result.errors).toEqual([`urlscan ${LIBRARY.slice(0, 12)}: seen on more than 99 domains, treated as a shared library`]);
	});

	test("skips widely shared files and requires a shared script", async () => {
		const { fetch, queries } = urlscan({
			[SCRIPT]: ["login.example.com", "sibling.example.net", "other-kit.example.net"],
			// A stylesheet on 26+ domains is a shared template, even though a script may be that common.
			[STYLE]: ["login.example.com", "sibling.example.net", ...manyDomains(30, "template-user")],
			// A library on 100+ domains is not one operator's kit.
			[LIBRARY]: ["login.example.com", ...manyDomains(120, "library-user")],
		});
		const result = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitResources: async () => RESOURCES.filter(({ sha256 }) => sha256 !== BACKEND_SCRIPT),
			fetch,
		});
		expect(queries.map((query) => query.searchParams.get("size"))).toEqual(["100", "100", "26"]);
		expect(queries[0]!.searchParams.get("collapse")).toBe("page.domain.keyword");
		expect(result.candidates).toEqual([
			{ domain: "sibling.example.net", url: "https://sibling.example.net/signin", matchingHashes: [SCRIPT] },
			{ domain: "other-kit.example.net", url: "https://other-kit.example.net/signin", matchingHashes: [SCRIPT] },
		]);
		expect(result.errors).toEqual([
			`urlscan ${LIBRARY.slice(0, 12)}: seen on more than 99 domains, treated as a shared library`,
			`urlscan ${STYLE.slice(0, 12)}: seen on more than 25 domains, treated as a shared library`,
		]);
	});

	test("a stylesheet alone never makes a candidate", async () => {
		const { fetch } = urlscan({
			[SCRIPT]: ["login.example.com", "sibling.example.net"],
			[STYLE]: ["login.example.com", "sibling.example.net", "template-only.example.net"],
		});
		const result = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitResources: async () => RESOURCES.slice(0, 2),
			fetch,
		});
		expect(result.candidates).toEqual([{ domain: "sibling.example.net", url: "https://sibling.example.net/signin", matchingHashes: [SCRIPT, STYLE] }]);
	});

	test("does not search at all without a captured script", async () => {
		const { fetch, queries } = urlscan({ [STYLE]: ["sibling.example.net"] });
		const stylesOnly = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitResources: async () => RESOURCES.filter(({ mimeType }) => mimeType === "text/css"),
			fetch,
		});
		expect(stylesOnly.candidates).toEqual([]);
		expect(stylesOnly.errors).toEqual(["The capture recorded no script large enough to identify a kit."]);
		const legacy = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitResources: async () => undefined,
			fetch,
		});
		expect(legacy).toEqual({ fingerprints: [], candidates: [], errors: ["The capture recorded no scripts or stylesheets."] });
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
