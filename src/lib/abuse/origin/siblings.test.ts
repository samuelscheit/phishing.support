import { describe, expect, test } from "bun:test";

import { createHash } from "node:crypto";

import { CORUNA_FRAME_URL, CORUNA_LOADER } from "../../malware/coruna_loader.fixture";
import type { WebsiteHiddenFrame, WebsiteKitResource } from "../../website_types";
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

const noPopularDomains = async () => new Set<string>();

const manyDomains = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}-${index}.example.org`);

describe("kit sibling discovery", () => {
	test("fingerprints every host's scripts and stylesheets, scripts first", () => {
		expect(kitFingerprints({ kitResources: RESOURCES })).toEqual([
			{ sha256: LIBRARY, kind: "script", url: "https://cdn.example.net/jquery.min.js", size: 90_000 },
			{ sha256: SCRIPT, kind: "script", url: "https://login.example.com/index.js", size: 58_737 },
			{ sha256: BACKEND_SCRIPT, kind: "script", url: "https://backend.example.net/gmail/js/start.js", size: 3_280 },
			{ sha256: STYLE, kind: "stylesheet", url: "https://login.example.com/res/css/style.css?v=4", size: 14_364 },
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
			loadKitCapture: async () => ({ kitResources: loader }),
			fetch,
			loadPopularDomains: noPopularDomains,
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
			loadKitCapture: async () => ({ kitResources: RESOURCES.filter(({ sha256 }) => sha256 !== BACKEND_SCRIPT) }),
			fetch,
			loadPopularDomains: noPopularDomains,
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
			loadKitCapture: async () => ({ kitResources: RESOURCES.slice(0, 2) }),
			fetch,
			loadPopularDomains: noPopularDomains,
		});
		expect(result.candidates).toEqual([{ domain: "sibling.example.net", url: "https://sibling.example.net/signin", matchingHashes: [SCRIPT, STYLE] }]);
	});

	test("does not search at all without a captured script", async () => {
		const { fetch, queries } = urlscan({ [STYLE]: ["sibling.example.net"] });
		const stylesOnly = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitCapture: async () => ({ kitResources: RESOURCES.filter(({ mimeType }) => mimeType === "text/css") }),
			fetch,
			loadPopularDomains: noPopularDomains,
		});
		expect(stylesOnly.candidates).toEqual([]);
		expect(stylesOnly.errors).toEqual(["The capture recorded no script or hidden frame large enough to identify a kit."]);
		const legacy = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitCapture: async () => undefined,
			fetch,
			loadPopularDomains: noPopularDomains,
		});
		expect(legacy).toEqual({ fingerprints: [], candidates: [], errors: ["The capture recorded no scripts, stylesheets, or hidden frames."] });
		expect(queries).toHaveLength(0);
	});

	test("never takes the brand a clone copied its files from for a sibling", async () => {
		// assistdeparments-x.com (production case 378865919855693904) serves X's
		// own web bundle: its hashes led to x.com itself.
		const { fetch } = urlscan({
			[SCRIPT]: [
				"login.example.com",
				"x.com",
				"abs.twimg.com",
				// Tenants of ranked platforms are their own sites.
				"x-clone.workers.dev",
				"quiz.int.vidio.com.ntc.fzstore.dpdns.org",
				// A path-tenant host is never judged by its hostname.
				"sites.google.com",
				"clone.example.net",
			],
		});
		const result = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitCapture: async () => ({ kitResources: RESOURCES.slice(0, 1) }),
			fetch,
			loadPopularDomains: async () => new Set(["x.com", "twimg.com", "workers.dev", "dpdns.org", "google.com"]),
		});
		expect(result.candidates.map(({ domain }) => domain)).toEqual([
			"x-clone.workers.dev",
			"quiz.int.vidio.com.ntc.fzstore.dpdns.org",
			"sites.google.com",
			"clone.example.net",
		]);
		expect(result.errors).toEqual(["x.com, abs.twimg.com: a top-ranked site (Tranco), the original the kit copied files from, not a sibling"]);
	});

	test("loads the popular-site list only when there is a candidate to judge", async () => {
		const { fetch } = urlscan({ [SCRIPT]: ["login.example.com"] });
		const result = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitCapture: async () => ({ kitResources: RESOURCES.slice(0, 1) }),
			fetch,
			loadPopularDomains: async () => { throw new Error("Tranco must not be asked"); },
		});
		expect(result).toEqual({ fingerprints: kitFingerprints({ kitResources: RESOURCES.slice(0, 1) }), candidates: [], errors: [] });
	});

	test("fails the search when the popular-site list is unavailable, rather than letting brands through", async () => {
		const { fetch } = urlscan({ [SCRIPT]: ["login.example.com", "x.com"] });
		await expect(findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadKitCapture: async () => ({ kitResources: RESOURCES.slice(0, 1) }),
			fetch,
			loadPopularDomains: async () => { throw new Error("Tranco is down"); },
		})).rejects.toThrow("Tranco is down");
	});

	test("accepts a candidate only when the swept origin presents its certificate", async () => {
		const { fetch } = urlscan({ [SCRIPT]: ["sibling.example.net", "unrelated.example.org"] });
		const result = await discoverSiblingDomains({
			submissionId: 1n,
			originalDomain: "login.example.com",
			originServers: [{ ip: "8.8.8.8", certificate: { names: ["login.example.com"], issuer: "CA", fingerprint256: "AA", notBefore: "2026-01-01", notAfter: "2027-01-01" } }],
		}, {
			apiKey: "secret-test-key",
			loadKitCapture: async () => ({ kitResources: RESOURCES.slice(0, 1) }),
			fetch,
			loadPopularDomains: noPopularDomains,
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

	describe("an exploit kit found through the loader in its hidden frame (production case 377486973465530391)", () => {
		const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
		const ORIGIN_LOADER = Buffer.from(CORUNA_LOADER);
		// Cloudflare in front of the seed adds its beacon line; the lure domains without Cloudflare serve the loader as is.
		const SERVED_LOADER = Buffer.from(CORUNA_LOADER.replace("</body>", `<script defer src="https://static.cloudflareinsights.com/beacon.min.js/vcd15cbe7772f49c399c6a5babf22c1241717689176015" data-cf-beacon='{"token":"t"}' crossorigin="anonymous"></script>\n</body>`));
		const frame = (document: Buffer, source = document.toString("utf8")): WebsiteHiddenFrame => ({
			ref: "frame1", url: CORUNA_FRAME_URL, hiddenBy: "0×0 size", sha256: sha(document), size: document.byteLength, source,
			resources: [], sentRequests: [], signals: { platformGate: [], runsFetchedCode: false, stageUrls: [], dataUploads: [] }, userAgent: "ua",
		});
		// The fake-captcha lure the kit wraps itself in is on hundreds of unrelated domains.
		const LURE_SCRIPT = hash("9");
		const LURE: WebsiteKitResource[] = [{ url: "https://92haoyun.icu/src/recaptcha.js", mimeType: "application/javascript", size: 29_098, sha256: LURE_SCRIPT }];
		const FRONTS = ["ktrced.top", "crhhmd.top", "cshsus.top", "kcfmfk.ltd", "tucuem.icu"];

		test("a frame document is code: as received, and as its origin served it when the CDN inserted tags", () => {
			expect(kitFingerprints({ hiddenFrames: [frame(SERVED_LOADER)] })).toEqual([
				{ sha256: sha(SERVED_LOADER), kind: "hidden_frame", url: CORUNA_FRAME_URL, size: SERVED_LOADER.byteLength },
				{ sha256: sha(ORIGIN_LOADER), kind: "hidden_frame", url: CORUNA_FRAME_URL, size: ORIGIN_LOADER.byteLength },
			]);
			// No CDN, one hash.
			expect(kitFingerprints({ hiddenFrames: [frame(ORIGIN_LOADER)] }).map(({ sha256 }) => sha256)).toEqual([sha(ORIGIN_LOADER)]);
			// A source the capture cut short cannot be re-hashed.
			expect(kitFingerprints({ hiddenFrames: [frame(SERVED_LOADER, SERVED_LOADER.toString("utf8").slice(0, 2_000))] }).map(({ sha256 }) => sha256)).toEqual([sha(SERVED_LOADER)]);
			// A tracking pixel frame is too small to identify anything; a non-public frame URL is no evidence.
			expect(kitFingerprints({ hiddenFrames: [frame(Buffer.from("<html><body></body></html>"))] })).toEqual([]);
			expect(kitFingerprints({ hiddenFrames: [{ ...frame(ORIGIN_LOADER), url: "http://127.0.0.1/gooll.html" }] })).toEqual([]);
		});

		test("the lure domains are found through the loader's origin hash, though the shared lure script is on hundreds of sites", async () => {
			const { fetch, queries } = urlscan({
				[sha(ORIGIN_LOADER)]: [...FRONTS, "92haoyun.icu"],
				[LURE_SCRIPT]: manyDomains(250, "captcha"),
			});
			const result = await findKitSiblingCandidates({ submissionId: 377486973465530391n, originalDomain: "92haoyun.icu" }, {
				apiKey: "test-key",
				loadKitCapture: async () => ({ kitResources: LURE, hiddenFrames: [frame(SERVED_LOADER)] }),
				fetch,
				loadPopularDomains: noPopularDomains,
			});
			expect(result.candidates.map(({ domain }) => domain)).toEqual(FRONTS);
			expect(result.candidates[0]).toEqual({ domain: "ktrced.top", url: "https://ktrced.top/signin", matchingHashes: [sha(ORIGIN_LOADER)] });
			expect(result.errors).toContain(`urlscan ${LURE_SCRIPT.slice(0, 12)}: seen on more than 99 domains, treated as a shared library`);
			// Every fingerprint is searched once, frames held to the script limit.
			expect(queries.map((query) => query.searchParams.get("size"))).toEqual(["100", "100", "100"]);
		});

		test("a capture with only a hidden frame still searches", async () => {
			const { fetch } = urlscan({ [sha(ORIGIN_LOADER)]: FRONTS });
			const result = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "92haoyun.icu" }, {
				apiKey: "test-key",
				loadKitCapture: async () => ({ hiddenFrames: [frame(ORIGIN_LOADER)] }),
				fetch,
				loadPopularDomains: noPopularDomains,
			});
			expect(result.candidates).toHaveLength(FRONTS.length);
			expect(result.errors).toEqual([]);
		});
	});
});
