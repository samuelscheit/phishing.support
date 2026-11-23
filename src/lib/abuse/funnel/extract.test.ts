import { describe, expect, test } from "bun:test";

import { extractFunnel } from "./extract";
import { landingIdentifiers, recogniseTracker } from "./platforms";
import { chainOf, CHECKOUT_TEXT, LURE_TEXT, PRODUCTION_URLS, productionChain } from "./test_fixtures";
import { decodeWrappedUrl, wrappedUrls } from "./wrappers";

describe("decodeWrappedUrl", () => {
	const target = "https://miamitrk.com/?a=15065&c=181082&s1=128_";
	const base64 = Buffer.from(target).toString("base64");

	test("reads a plain, a percent-encoded and a doubly percent-encoded URL", () => {
		expect(decodeWrappedUrl(target)).toEqual({ url: target, encoding: "plain" });
		expect(decodeWrappedUrl(encodeURIComponent(target))).toEqual({ url: target, encoding: "percent" });
		expect(decodeWrappedUrl(encodeURIComponent(encodeURIComponent(target)))).toEqual({ url: target, encoding: "percent" });
	});

	test("reads base64 with and without a marker, in the URL-safe alphabet, and base64 of a percent-encoded URL", () => {
		expect(decodeWrappedUrl(base64)).toEqual({ url: target, encoding: "base64" });
		expect(decodeWrappedUrl(`BASE64${base64}`)).toEqual({ url: target, encoding: "base64" });
		expect(decodeWrappedUrl(`b64:${base64}`)).toEqual({ url: target, encoding: "base64" });
		const urlSafe = Buffer.from("https://x.example/?q=>>>???").toString("base64url");
		expect(urlSafe).toMatch(/[-_]/);
		expect(decodeWrappedUrl(urlSafe)?.url).toBe("https://x.example/?q=%3E%3E%3E???");
		expect(decodeWrappedUrl(Buffer.from(encodeURIComponent(target)).toString("base64"))).toEqual({ url: target, encoding: "base64" });
	});

	test("reads base64 nested in base64", () => {
		const nested = Buffer.from(base64).toString("base64");
		expect(decodeWrappedUrl(nested)).toEqual({ url: target, encoding: "base64" });
	});

	test("rejects values that are no URL", () => {
		for (const value of ["", "3079", "d2d5aa5e17414bd4a51fd8ea730f830a", Buffer.from("not a url at all").toString("base64"), "javascript:alert(1)", Buffer.from("ftp://files.example/x").toString("base64"), "https://"]) {
			expect(decodeWrappedUrl(value)).toBeUndefined();
		}
	});

	test("finds wrapped URLs in parameters and path segments, each once, and survives a '+' the query string turned into a space", () => {
		const withPlus = Buffer.from("https://a.example/?x=~~~>").toString("base64");
		expect(withPlus).toContain("+");
		const url = new URL(`https://r.example/go/${base64}?u=${encodeURIComponent(target)}&next=${withPlus}&id=3079`);
		expect(wrappedUrls(url)).toEqual([
			{ parameter: "u", encoding: "plain", url: target },
			{ parameter: "next", encoding: "base64", url: "https://a.example/?x=~~~%3E" },
		]);
		expect(wrappedUrls(new URL(`https://r.example/go/${base64}`))).toEqual([{ parameter: "path", encoding: "base64", url: target }]);
	});
});

describe("recogniseTracker", () => {
	const recognise = (url: string) => recogniseTracker(new URL(url));

	test("CAKE: a/c on the root path, certain with its click markers", () => {
		const plain = recognise("https://miamitrk.com/?a=15065&c=181082&s1=128_&s2=abc&s3=3079");
		// The shape alone is common; only CAKE's own click markers make it certain.
		expect(plain).toMatchObject({ platform: "cake", role: "network", confidence: "low" });
		expect(plain?.identifiers).toEqual(expect.arrayContaining([
			{ kind: "affiliate", parameter: "a", value: "15065" },
			{ kind: "creative", parameter: "c", value: "181082" },
			{ kind: "sub", parameter: "s1", value: "128_" },
			{ kind: "sub", parameter: "s3", value: "3079" },
		]));
		expect(recognise(PRODUCTION_URLS.cakeCookieCheck)).toMatchObject({ platform: "cake", confidence: "high" });
		expect(recognise(PRODUCTION_URLS.cakeCookieCheck)?.identifiers).toContainEqual({ kind: "click", parameter: "ckmxid", value: "d0o41bd00000gu4vb1j0" });
		expect(recognise("https://track.example/?a=12&ckmguid=abc-def")).toMatchObject({ platform: "cake", confidence: "high" });
	});

	test("CAKE: a non-numeric affiliate, a missing creative, or a deep path is not CAKE", () => {
		expect(recognise("https://shop.example/?a=abc&c=12")).toBeUndefined();
		expect(recognise("https://shop.example/?a=12")).toBeUndefined();
		expect(recognise("https://shop.example/product/view?a=12&c=34")).toBeUndefined();
	});

	test("Everflow: affiliate then offer in the path, certain with its parameters", () => {
		const link = recognise(PRODUCTION_URLS.everflowLink);
		expect(link).toMatchObject({ platform: "everflow", role: "network", confidence: "high" });
		expect(link?.identifiers.slice(0, 2)).toEqual([
			{ kind: "affiliate", parameter: "path", value: "6RNXHT" },
			{ kind: "offer", parameter: "path", value: "2HSS8TK" },
		]);
		const redirect = recognise(PRODUCTION_URLS.everflowRedirect);
		expect(redirect?.identifiers).toEqual(expect.arrayContaining([
			{ kind: "offer", parameter: "path", value: "28DHQGH" },
			{ kind: "other", parameter: "__ptid", value: "83df736cd5f44c7c9c591bcf5bd74bce" },
			{ kind: "other", parameter: "__po", value: "864" },
		]));
		expect(recognise("https://www.tracking-domain.test/28KL6/2CTPL/")).toMatchObject({ platform: "everflow", confidence: "low" });
	});

	test("Everflow: a smart link names its path without guessing which ID is which", () => {
		const smart = recognise("http://www.servetrack2.test/cmp/5TMX8/27W1G/?sub1=facebook&sub3=media_buying");
		expect(smart).toMatchObject({ platform: "everflow", confidence: "high" });
		expect(smart?.identifiers[0]).toEqual({ kind: "campaign", parameter: "path", value: "5TMX8/27W1G" });
		expect(smart?.identifiers.some((identifier) => identifier.kind === "affiliate")).toBeFalse();
	});

	test("Everflow: ordinary two-segment paths are not Everflow", () => {
		for (const url of ["https://shop.example/en/shoes/", "https://shop.example/ABCD/EFGH/", "https://shop.example/1234/5678/", "https://shop.example/2ctpl/28kl6/"]) {
			expect(recognise(url)).toBeUndefined();
		}
	});

	test("TUNE: /aff_c with offer_id and aff_id, sub IDs and transaction", () => {
		const link = recognise("http://demo.go2cloud.org/aff_c?offer_id=1001&aff_id=2002&aff_sub=AFFSUB&aff_sub2=AFFSUB2&source=SOURCE&transaction_id=102abc");
		expect(link).toMatchObject({ platform: "tune", role: "network", confidence: "high" });
		expect(link?.identifiers).toEqual([
			{ kind: "affiliate", parameter: "aff_id", value: "2002" },
			{ kind: "offer", parameter: "offer_id", value: "1001" },
			{ kind: "sub", parameter: "aff_sub", value: "AFFSUB" },
			{ kind: "sub", parameter: "aff_sub2", value: "AFFSUB2" },
			{ kind: "sub", parameter: "source", value: "SOURCE" },
			{ kind: "transaction", parameter: "transaction_id", value: "102abc" },
		]);
		expect(recognise("https://n.example/aff_c?offer_id=7")).toMatchObject({ platform: "tune", confidence: "medium" });
		expect(recognise("https://n.example/aff_c")).toBeUndefined();
	});

	test("self-run trackers: Voluum, Binom, Keitaro, RedTrack", () => {
		expect(recognise(PRODUCTION_URLS.voluumClick)).toMatchObject({ platform: "voluum", role: "affiliate_tracker", confidence: "high" });
		const campaign = recognise(PRODUCTION_URLS.voluumCampaign);
		expect(campaign).toMatchObject({ platform: "voluum", role: "affiliate_tracker", confidence: "medium" });
		expect(campaign?.identifiers).toEqual(expect.arrayContaining([
			{ kind: "campaign", parameter: "path", value: "4df5378b-a236-4c67-b2d3-cbbb2e9d4b92" },
			{ kind: "click", parameter: "clickid", value: "584e52702a4f4436b6d677b95a955ee8", confidence: "medium" },
		]));
		expect(recognise("https://wtrck.com/click")).toBeUndefined();
		expect(recognise("https://t.example/click.php?key=s0me4key&t1=x")).toMatchObject({ platform: "binom", identifiers: [{ kind: "campaign", parameter: "key", value: "s0me4key" }] });
		expect(recognise("https://t.example/click.php?lp=1&uclick=abc123")).toMatchObject({ platform: "binom", identifiers: [{ kind: "click", parameter: "uclick", value: "abc123" }] });
		expect(recognise("https://k.example/?_lp=1&_token=uuid-token&offer_id=5")).toMatchObject({ platform: "keitaro", identifiers: [{ kind: "offer", parameter: "offer_id", value: "5" }] });
		expect(recognise("https://shop.example/?rtkcid=6512abc&rtkcmpid=64ff")).toMatchObject({ platform: "redtrack", role: "affiliate_tracker" });
	});

	test("unexpanded macros are no identifiers", () => {
		const link = recognise("https://miamitrk.com/?a=15065&c=181082&s1=#s1#&s2={clickid}&s3=[sub3]");
		expect(link?.identifiers).toEqual([
			{ kind: "affiliate", parameter: "a", value: "15065" },
			{ kind: "creative", parameter: "c", value: "181082" },
		]);
	});

	test("landing identifiers of an advertiser's checkout", () => {
		expect(landingIdentifiers(new URL(PRODUCTION_URLS.checkout))).toEqual([
			{ kind: "affiliate", parameter: "affid", value: "15065", confidence: "medium" },
			{ kind: "sub", parameter: "sub1", value: "128_", confidence: "low" },
			{ kind: "sub", parameter: "sub2", value: "dke0kbl56rbr55umj7k6ku34", confidence: "low" },
			{ kind: "sub", parameter: "sub3", value: "43769-951152199", confidence: "low" },
		]);
		expect(landingIdentifiers(new URL(PRODUCTION_URLS.lure))).toContainEqual({ kind: "lander_token", parameter: "lptoken", value: "171195eb47ee06ab8010", confidence: "medium" });
	});
});

describe("extractFunnel", () => {
	const parties = (urls: string[], shown: Record<number, string>) => extractFunnel(chainOf(urls, shown)).parties;

	test("the production chain: Everflow → Voluum → lure → Voluum → wrapper → CAKE → Zatos checkout", () => {
		const extraction = extractFunnel(productionChain());
		expect(extraction.hopKinds.map(({ kind }) => kind)).toEqual(["tracker", "tracker", "tracker", "lure", "tracker", "redirector", "tracker", "tracker", "merchant"]);
		expect(extraction.trackingHops.map(({ hopIndex, platform, role, confidence }) => [hopIndex, platform, role, confidence])).toEqual([
			[0, "everflow", "network", "high"],
			[1, "everflow", "network", "high"],
			[2, "voluum", "affiliate_tracker", "medium"],
			[4, "voluum", "affiliate_tracker", "high"],
			[6, "cake", "network", "low"],
			[7, "cake", "network", "high"],
		]);
		expect(extraction.redirectors).toEqual([{ hopIndex: 5, url: PRODUCTION_URLS.wrapper, site: "sdsecurenetwork.com", parameter: "target", encoding: "base64", target: PRODUCTION_URLS.cakeLink }]);
		expect(extraction.merchant).toMatchObject({ hopIndex: 8, site: "zatos.com", hostname: "www.zatos.com", url: PRODUCTION_URLS.checkout });
		expect(extraction.lurePageHops).toEqual([3]);
		expect(extraction.affiliates).toEqual([
			{ id: "6RNXHT", site: "onlinesafetyall.com", platform: "everflow", parameter: "path", hopIndices: [0, 1], confidence: "high", matchedAt: [] },
			{ id: "15065", site: "miamitrk.com", platform: "cake", parameter: "a", hopIndices: [7], confidence: "high", matchedAt: ["zatos.com"] },
			{ id: "15065", site: "zatos.com", parameter: "affid", hopIndices: [8], confidence: "high", matchedAt: ["miamitrk.com"] },
		]);
		expect(extraction.parties).toEqual([
			{ role: "merchant", site: "zatos.com", hostnames: ["www.zatos.com"], affiliateIds: ["15065"], hopIndices: [8] },
			{ role: "network", site: "onlinesafetyall.com", hostnames: ["www.onlinesafetyall.com"], platform: "everflow", platformConfidence: "high", affiliateIds: ["6RNXHT"], hopIndices: [0, 1] },
			{ role: "network", site: "miamitrk.com", hostnames: ["miamitrk.com"], platform: "cake", platformConfidence: "high", affiliateIds: ["15065"], hopIndices: [7] },
		]);
		const carried = new Map(extraction.carriedValues.map(({ value, seenAt }) => [value, seenAt.map(({ site, parameter }) => `${site}:${parameter}`)]));
		expect(carried.get("3079")).toEqual(["onlinesafetyall.com:sub1", "wtrck.com:s3", "ultimateprizesearch.com:s3", "miamitrk.com:s3"]);
		expect(carried.get("dke0kbl56rbr55umj7k6ku34")).toEqual(["miamitrk.com:s2", "zatos.com:sub2"]);
		expect(carried.has("128")).toBeFalse();
	});

	test("a chain without any tracker has no merchant, no affiliates and no parties", () => {
		const extraction = extractFunnel(chainOf(["https://short.example/x", "https://shop.example/checkout?ref=home"], { 1: "Buy now" }));
		expect(extraction.merchant).toBeUndefined();
		expect(extraction.trackingHops).toEqual([]);
		expect(extraction.parties).toEqual([]);
		expect(extraction.hopKinds.map(({ kind }) => kind)).toEqual(["redirect", "lure"]);
	});

	test("a chain that ends on a tracker still names the network, but no merchant", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/win", "https://miamitrk.com/?a=15065&c=181082&ckmxid=q"], { 0: "You won" }));
		expect(extraction.merchant).toBeUndefined();
		expect(extraction.parties).toEqual([{ role: "network", site: "miamitrk.com", hostnames: ["miamitrk.com"], platform: "cake", platformConfidence: "high", affiliateIds: ["15065"], hopIndices: [1] }]);
	});

	test("CAKE's shape without its click markers is evidence only, never a party", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/win", "https://shop.example/?a=15065&c=181082", "https://store.example/checkout"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(extraction.trackingHops.map(({ platform, confidence }) => [platform, confidence])).toEqual([["cake", "low"]]);
		expect(extraction.merchant).toBeUndefined();
		expect(extraction.parties).toEqual([]);
	});

	test("a tracker the visit never reached, only carried in a wrapper, is evidence, never a party", () => {
		const target = "https://n.example/aff_c?offer_id=11&aff_id=4242";
		const chain = chainOf(["https://lure.example/claim", `https://r.example/go?url=${Buffer.from(target).toString("base64")}`], { 0: "Claim your prize" });
		chain.hops[1]!.redirectTo = undefined;
		const extraction = extractFunnel(chain);
		expect(extraction.trackingHops).toEqual([expect.objectContaining({ hopIndex: 1, platform: "tune", url: target, carriedBy: { parameter: "url", encoding: "base64" } })]);
		expect(extraction.affiliates).toEqual([]);
		expect(extraction.parties).toEqual([]);
		expect(extraction.redirectors[0]).toMatchObject({ hopIndex: 1, target });
	});

	test("a fallback URL in a redirect's parameters neither makes a network party nor credits the merchant", () => {
		const fallback = encodeURIComponent("https://othernet.example/?a=9999&c=1234&ckmxid=z");
		const extraction = extractFunnel(chainOf([
			"https://lure.example/a",
			`https://n.example/aff_c?offer_id=11&aff_id=4242&fallback=${fallback}`,
			"https://shop.example/checkout",
		], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(extraction.trackingHops.map(({ site, carriedBy }) => [site, Boolean(carriedBy)])).toEqual([["n.example", false], ["othernet.example", true]]);
		expect(extraction.parties.map(({ site, creditedBy }) => [site, creditedBy?.site])).toEqual([["shop.example", "n.example"], ["n.example", undefined]]);
		expect(extraction.affiliates.map(({ id }) => id)).toEqual(["4242"]);
	});

	test("a network link before the lure fed the lure: it neither makes the merchant nor credits it", () => {
		// Everflow 6RNXHT → lure → the affiliate's own Voluum → smallbrand-shop.com.
		const extraction = extractFunnel(chainOf([
			PRODUCTION_URLS.everflowLink,
			"https://lure.example/apply",
			"https://t.example/click/1?cep=abc",
			"https://smallbrand-shop.com/product",
		], { 1: LURE_TEXT, 3: CHECKOUT_TEXT }));
		expect(extraction.merchant).toBeUndefined();
		expect(extraction.parties.map(({ role, site }) => [role, site])).toEqual([["network", "onlinesafetyall.com"]]);
		// With its own affiliate ID landing on it, the shop is a merchant, but no network credits it.
		const landed = extractFunnel(chainOf([
			PRODUCTION_URLS.everflowLink,
			"https://lure.example/apply",
			"https://t.example/click/1?cep=abc",
			"https://smallbrand-shop.com/product?affid=SB77",
		], { 1: LURE_TEXT, 3: CHECKOUT_TEXT }));
		expect(landed.parties[0]).toEqual({ role: "merchant", site: "smallbrand-shop.com", hostnames: ["smallbrand-shop.com"], affiliateIds: ["SB77"], hopIndices: [3] });
	});

	test("a generic parameter on a platform's link keeps its own weak confidence: no affiliate from pid or aff", () => {
		const everflow = extractFunnel(chainOf(["https://lure.example/a", "https://ef.example/cmp/5TMX8/27W1G/?sub1=x&pid=4471", "https://shop.example/x"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(everflow.affiliates).toEqual([]);
		expect(everflow.parties).toEqual([]);
		const cake = extractFunnel(chainOf(["https://lure.example/a", "https://miamitrk.com/?a=15065&c=1&ckmxid=q&aff=777", "https://shop.example/x"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(cake.affiliates.map(({ id }) => id)).toEqual(["15065"]);
		expect(cake.parties.find(({ role }) => role === "network")?.affiliateIds).toEqual(["15065"]);
		// A named affiliate parameter on a platform's link is as sure as the parameter name, not the link.
		const named = extractFunnel(chainOf(["https://lure.example/a", "https://miamitrk.com/?a=15065&c=1&ckmxid=q&affiliate_id=A-77", "https://shop.example/x"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(named.affiliates.map(({ id, confidence }) => [id, confidence])).toEqual([["15065", "high"], ["A-77", "medium"]]);
	});

	test("a redirect's Location the visit never followed is read as well", () => {
		const chain = chainOf(["https://lure.example/claim", "https://r.example/next"], { 0: "Claim your prize" });
		chain.hops[1]!.redirectTo = "https://miamitrk.com/?a=99&ckmxid=x1";
		expect(extractFunnel(chain).trackingHops).toEqual([expect.objectContaining({ platform: "cake", hopIndex: 1, carriedBy: { parameter: "Location", encoding: "location" } })]);
	});

	test("links on a page the visitor was shown are no part of the chain: a checkout's return_url names no network", () => {
		const cart = `https://shop.example/checkout?affid=ABCD&return_url=${encodeURIComponent("https://n.example/aff_c?offer_id=1&aff_id=9999")}`;
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://miamitrk.com/?a=777&c=1&ckmxid=x", cart], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(extraction.trackingHops.map(({ site }) => site)).toEqual(["miamitrk.com"]);
		expect(extraction.parties.map(({ site }) => site)).toEqual(["shop.example", "miamitrk.com"]);
	});

	test("several networks in one chain each become a party with their own affiliate", () => {
		expect(parties([
			"https://lure.example/survey",
			"https://ef.example/2ABCD/3EFGH/?sub1=x9",
			"https://n.example/aff_c?offer_id=11&aff_id=4242",
			"https://shop.example/buy?aff_id=777",
		], { 0: "Survey complete! Claim", 3: "Checkout" }).map(({ role, site, platform, affiliateIds }) => [role, site, platform, affiliateIds])).toEqual([
			["merchant", "shop.example", undefined, ["777"]],
			["network", "ef.example", "everflow", ["2ABCD"]],
			["network", "n.example", "tune", ["4242"]],
		]);
	});

	test("a merchant without its own affiliate parameter is credited with the network's ID, never named by it", () => {
		expect(parties(["https://lure.example/a", "https://miamitrk.com/?a=15065&c=1&ckmxid=q", "https://shop.example/checkout"], { 0: "Act now", 2: CHECKOUT_TEXT })[0]).toEqual({
			role: "merchant",
			site: "shop.example",
			hostnames: ["shop.example"],
			affiliateIds: [],
			creditedBy: { site: "miamitrk.com", platform: "cake", platformConfidence: "high", id: "15065" },
			hopIndices: [2],
		});
	});

	test("a product pid on the merchant's landing URL is no affiliate ID", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://miamitrk.com/?a=15065&c=1&ckmxid=q", "https://shop.example/product?pid=4471"], { 0: "Act now", 2: CHECKOUT_TEXT }));
		expect(extraction.affiliates.map(({ id }) => id)).toEqual(["15065"]);
		expect(extraction.parties[0]).toMatchObject({ role: "merchant", affiliateIds: [], creditedBy: { id: "15065" } });
	});

	test("a short ID that recurs on the next business is a coincidence, not a match", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://n.example/aff_c?offer_id=1&aff_id=12", "https://shop.example/x?affid=12"], { 0: "Act now", 2: "Shop" }));
		expect(extraction.affiliates.map(({ site, confidence, matchedAt }) => [site, confidence, matchedAt])).toEqual([["n.example", "high", []], ["shop.example", "medium", []]]);
	});

	test("a merchant running its own CAKE on a subdomain is one party, the merchant", () => {
		expect(parties(["https://lure.example/a", "https://track.shop.example/?a=55&c=2&ckmxid=q", "https://www.shop.example/checkout?affid=55"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT })).toEqual([
			{ role: "merchant", site: "shop.example", hostnames: ["track.shop.example", "www.shop.example"], platform: "cake", platformConfidence: "high", affiliateIds: ["55"], hopIndices: [1, 2] },
		]);
	});

	test("a page shown on a URL that only looks like a tracker stays a page", () => {
		const extraction = extractFunnel(chainOf(["https://news.example/2024/AB12CD/", "https://miamitrk.com/?a=1&c=2&ckmxid=q", "https://shop.example/x"], { 0: "Article", 2: "Shop" }));
		expect(extraction.hopKinds.map(({ kind }) => kind)).toEqual(["lure", "tracker", "merchant"]);
	});

	test("generic affiliate parameters on a redirect never make a tracker or a party (paypal.com?partner_id=)", () => {
		for (const redirect of ["https://www.paypal.com/signin?partner_id=ABC123", "https://go.partners.example/r?affiliate_id=A-77&subid=z", "https://r.example/?pid=5"]) {
			const extraction = extractFunnel(chainOf(["https://lure.example/a", redirect, "https://shop.example/x"], { 0: "Act now", 2: "Shop" }));
			expect(extraction.trackingHops).toEqual([]);
			expect(extraction.merchant).toBeUndefined();
			expect(extraction.parties).toEqual([]);
		}
	});

	test("a lure that only passes the affiliate's own tracker into a big brand's page has no merchant", () => {
		// Probe: lure → a UUID path read as Voluum → www.costco.com.
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://t.example/4df5378b-a236-4c67-b2d3-cbbb2e9d4b92", "https://www.costco.com/"], { 0: LURE_TEXT, 2: "Costco Wholesale" }));
		expect(extraction.trackingHops.map(({ platform, confidence }) => [platform, confidence])).toEqual([["voluum", "medium"]]);
		expect(extraction.merchant).toBeUndefined();
		expect(extraction.parties).toEqual([]);
	});

	test("the affiliate's own tracker into a landing URL with an affiliate ID makes a merchant", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://t.example/click/1?cep=abc", "https://shop.example/x?affid=AB12"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(extraction.parties).toEqual([{ role: "merchant", site: "shop.example", hostnames: ["shop.example"], affiliateIds: ["AB12"], hopIndices: [2] }]);
	});

	test("Everflow's path alone is a guess that names no network", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://sho.rt/AB12C/XY9Z1", "https://shop.example/x"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(extraction.trackingHops.map(({ platform, confidence }) => [platform, confidence])).toEqual([["everflow", "low"]]);
		expect(extraction.parties).toEqual([]);
	});

	test("a platform's tenants are their own sites, never the platform owner; a platform host is no party", () => {
		const tenants = extractFunnel(chainOf([
			"https://lure.example/a",
			"https://track1.herokuapp.com/?a=5555&c=1&ckmxid=q",
			"https://store1.myshopify.com/checkout?affid=5555",
		], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(tenants.parties.map(({ role, site }) => [role, site])).toEqual([["merchant", "store1.myshopify.com"], ["network", "track1.herokuapp.com"]]);
		expect(tenants.affiliates.find(({ site }) => site === "store1.myshopify.com")?.matchedAt).toEqual(["track1.herokuapp.com"]);
		const two = extractFunnel(chainOf(["https://lure.example/a", "https://a1.pages.dev/?a=5555&c=1&ckmxid=q", "https://b2.pages.dev/checkout?affid=5555"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(two.parties.map(({ site }) => site)).toEqual(["b2.pages.dev", "a1.pages.dev"]);
		const pathTenant = extractFunnel(chainOf(["https://lure.example/a", "https://miamitrk.com/?a=15065&c=1&ckmxid=q", "https://sites.google.com/view/offer?affid=15065"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(pathTenant.merchant).toBeUndefined();
		expect(pathTenant.parties.map(({ site }) => site)).toEqual(["miamitrk.com"]);
		const owner = extractFunnel(chainOf(["https://lure.example/a", "https://myshopify.com/?a=15065&c=1&ckmxid=q", "https://shop.example/x?affid=15065"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(owner.parties.map(({ site }) => site)).toEqual(["shop.example"]);
	});

	test("hops come in any order and unparsable URLs are skipped", () => {
		const chain = productionChain();
		const shuffled = { ...chain, hops: [...chain.hops].reverse().concat({ index: 99, url: "not a url", hostname: "", status: null }) };
		expect(extractFunnel(shuffled)).toEqual(extractFunnel(chain));
	});
});
