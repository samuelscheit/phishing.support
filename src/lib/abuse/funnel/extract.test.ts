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
		expect(plain).toMatchObject({ platform: "cake", role: "network", confidence: "medium" });
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
		expect(recognise("https://www.tracking-domain.test/28KL6/2CTPL/")).toMatchObject({ platform: "everflow", confidence: "medium" });
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
			{ kind: "click", parameter: "clickid", value: "584e52702a4f4436b6d677b95a955ee8" },
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
	test("the production chain: Everflow → Voluum → lure → Voluum → wrapper → CAKE → Zatos checkout", () => {
		const extraction = extractFunnel(productionChain());
		expect(extraction.hopKinds.map(({ kind }) => kind)).toEqual(["tracker", "tracker", "tracker", "lure", "tracker", "redirector", "tracker", "tracker", "merchant"]);
		expect(extraction.trackingHops.map(({ hopIndex, platform, role }) => [hopIndex, platform, role])).toEqual([
			[0, "everflow", "network"],
			[1, "everflow", "network"],
			[2, "voluum", "affiliate_tracker"],
			[4, "voluum", "affiliate_tracker"],
			[6, "cake", "network"],
			[7, "cake", "network"],
		]);
		expect(extraction.redirectors).toEqual([{ hopIndex: 5, url: PRODUCTION_URLS.wrapper, site: "sdsecurenetwork.com", parameter: "target", encoding: "base64", target: PRODUCTION_URLS.cakeLink }]);
		expect(extraction.merchant).toMatchObject({ hopIndex: 8, site: "zatos.com", hostname: "www.zatos.com", url: PRODUCTION_URLS.checkout });
		expect(extraction.lurePageHops).toEqual([3]);
		expect(extraction.affiliates).toEqual([
			{ id: "6RNXHT", site: "onlinesafetyall.com", platform: "everflow", parameter: "path", hopIndices: [0, 1], confidence: "high", matchedAt: [] },
			{ id: "15065", site: "miamitrk.com", platform: "cake", parameter: "a", hopIndices: [6, 7], confidence: "high", matchedAt: ["zatos.com"] },
			{ id: "15065", site: "zatos.com", parameter: "affid", hopIndices: [8], confidence: "high", matchedAt: ["miamitrk.com"] },
		]);
		expect(extraction.parties).toEqual([
			{ role: "merchant", site: "zatos.com", hostnames: ["www.zatos.com"], affiliateIds: ["15065"], hopIndices: [8] },
			{ role: "network", site: "onlinesafetyall.com", hostnames: ["www.onlinesafetyall.com"], platform: "everflow", affiliateIds: ["6RNXHT"], hopIndices: [0, 1] },
			{ role: "network", site: "miamitrk.com", hostnames: ["miamitrk.com"], platform: "cake", affiliateIds: ["15065"], hopIndices: [6, 7] },
		]);
		const carried = new Map(extraction.carriedValues.map(({ value, seenAt }) => [value, seenAt.map(({ site, parameter }) => `${site}:${parameter}`)]));
		expect(carried.get("3079")).toEqual(expect.arrayContaining(["onlinesafetyall.com:sub1", "wtrck.com:s3", "ultimateprizesearch.com:s3", "miamitrk.com:s3"]));
		expect(carried.get("dke0kbl56rbr55umj7k6ku34")).toEqual(expect.arrayContaining(["miamitrk.com:s2", "zatos.com:sub2"]));
		expect(carried.has("128")).toBeFalse();
	});

	test("a chain without any tracker has no merchant, no affiliates and no parties", () => {
		const extraction = extractFunnel(chainOf(["https://short.example/x", "https://shop.example/checkout?ref=home"], { 1: "Buy now" }));
		expect(extraction.merchant).toBeUndefined();
		expect(extraction.trackingHops).toEqual([]);
		expect(extraction.parties).toEqual([]);
		expect(extraction.lurePageHops).toEqual([1]);
		expect(extraction.hopKinds.map(({ kind }) => kind)).toEqual(["redirect", "lure"]);
	});

	test("a chain that ends on a tracker still names the network, but no merchant", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/win", "https://miamitrk.com/?a=15065&c=181082"], { 0: "You won" }));
		expect(extraction.merchant).toBeUndefined();
		expect(extraction.parties).toEqual([{ role: "network", site: "miamitrk.com", hostnames: ["miamitrk.com"], platform: "cake", affiliateIds: ["15065"], hopIndices: [1] }]);
	});

	test("a wrapper whose target the visit never reached still yields the tracker it carried", () => {
		const target = "https://n.example/aff_c?offer_id=11&aff_id=4242";
		const chain = chainOf(["https://lure.example/claim", `https://r.example/go?url=${Buffer.from(target).toString("base64")}`], { 0: "Claim your prize" });
		chain.hops[1]!.redirectTo = undefined;
		const extraction = extractFunnel(chain);
		expect(extraction.trackingHops).toEqual([expect.objectContaining({ hopIndex: 1, platform: "tune", url: target, carriedBy: { parameter: "url", encoding: "base64" } })]);
		expect(extraction.parties).toEqual([{ role: "network", site: "n.example", hostnames: ["n.example"], platform: "tune", affiliateIds: ["4242"], hopIndices: [1] }]);
		expect(extraction.redirectors[0]).toMatchObject({ hopIndex: 1, target });
	});

	test("a redirect's Location the visit never followed is read as well", () => {
		const chain = chainOf(["https://lure.example/claim", "https://r.example/next"], { 0: "Claim your prize" });
		chain.hops[1]!.redirectTo = "https://miamitrk.com/?a=99&ckmxid=x1";
		expect(extractFunnel(chain).trackingHops).toEqual([expect.objectContaining({ platform: "cake", hopIndex: 1, carriedBy: { parameter: "Location", encoding: "location" } })]);
	});

	test("several networks in one chain each become a party with their own affiliate", () => {
		const extraction = extractFunnel(chainOf([
			"https://lure.example/survey",
			"https://ef.example/2ABCD/3EFGH/?sub1=x9",
			"https://n.example/aff_c?offer_id=11&aff_id=4242",
			"https://shop.example/buy?aff_id=777",
		], { 0: "Survey complete! Claim", 3: "Checkout" }));
		expect(extraction.parties.map(({ role, site, platform, affiliateIds }) => [role, site, platform, affiliateIds])).toEqual([
			["merchant", "shop.example", undefined, ["777"]],
			["network", "ef.example", "everflow", ["2ABCD"]],
			["network", "n.example", "tune", ["4242"]],
		]);
		expect(extraction.affiliates.every(({ matchedAt }) => matchedAt.length === 0)).toBeTrue();
		expect(extraction.affiliates.find(({ site }) => site === "shop.example")?.confidence).toBe("medium");
	});

	test("a merchant without an affiliate parameter is named with the affiliate of the network that delivered the visitor", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://miamitrk.com/?a=15065&c=1", "https://shop.example/checkout"], { 0: "Act now", 2: CHECKOUT_TEXT }));
		expect(extraction.parties[0]).toEqual({ role: "merchant", site: "shop.example", hostnames: ["shop.example"], affiliateIds: ["15065"], hopIndices: [2] });
		expect(extraction.merchant?.identifiers).toEqual([]);
	});

	test("a merchant running its own CAKE on a subdomain is one party, the merchant", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://track.shop.example/?a=55&c=2&ckmxid=q", "https://www.shop.example/checkout?affid=55"], { 0: LURE_TEXT, 2: CHECKOUT_TEXT }));
		expect(extraction.parties).toEqual([{ role: "merchant", site: "shop.example", hostnames: ["track.shop.example", "www.shop.example"], platform: "cake", affiliateIds: ["55"], hopIndices: [1, 2] }]);
	});

	test("a page shown on a URL that only looks like a tracker stays a page", () => {
		const extraction = extractFunnel(chainOf(["https://news.example/2024/AB12CD/", "https://miamitrk.com/?a=1&c=2", "https://shop.example/x"], { 0: "Article", 2: "Shop" }));
		expect(extraction.hopKinds.map(({ kind }) => kind)).toEqual(["lure", "tracker", "merchant"]);
	});

	test("an unknown redirect with an affiliate parameter is a low-confidence affiliate link", () => {
		const extraction = extractFunnel(chainOf(["https://lure.example/a", "https://go.partners.example/r?affiliate_id=A-77&subid=z", "https://shop.example/x"], { 0: "Act now", 2: "Shop" }));
		expect(extraction.trackingHops[0]).toMatchObject({ platform: "affiliate_link", role: "network", confidence: "low", site: "partners.example" });
		expect(extraction.parties.map(({ site, affiliateIds }) => [site, affiliateIds])).toEqual([["shop.example", ["A-77"]], ["partners.example", ["A-77"]]]);
		// A bare `pid` names too many other things to make a redirect an affiliate link.
		expect(extractFunnel(chainOf(["https://lure.example/a", "https://r.example/?pid=5", "https://shop.example/x"], { 0: "a", 2: "b" })).trackingHops).toEqual([]);
	});

	test("hops come in any order and unparsable URLs are skipped", () => {
		const chain = productionChain();
		const shuffled = { ...chain, hops: [...chain.hops].reverse().concat({ index: 99, url: "not a url", hostname: "", status: null }) };
		expect(extractFunnel(shuffled)).toEqual(extractFunnel(chain));
	});
});
