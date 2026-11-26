import { describe, expect, test } from "bun:test";

import { pageFingerprints } from "./page_fingerprint";
import { kitCapture as capture, templatePage } from "./test_mhtml";

const body = (host: string, cid: string, options: Parameters<typeof capture>[2] = {}) => pageFingerprints(capture(host, cid, options), `https://${host}/`).body;
const structure = (host: string, options: Parameters<typeof capture>[2]) => pageFingerprints(capture(host, "1", options), `https://${host}/`).structure;

describe("page body fingerprint", () => {
	test("one kit on many domains has one fingerprint, whatever the capture's part ids, encoding, or the deployment's <head>", () => {
		const a = body("napxu.hoanganhmedia.sbs", "1111");
		expect(a?.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(a?.size).toBeGreaterThan(3_000);
		expect(body("napxu.quanghung-media.site", "2222")?.sha256).toBe(a!.sha256);
		expect(body("deposit-dawn-hood.trycloudflare.com", "3333", { base64: true })?.sha256).toBe(a!.sha256);
		// One deployment of the kit adds a canonical link and analytics to its <head>: the same page.
		expect(body("shopxu.thuysimedia.online", "4444", { head: '<link rel="canonical" href="https://shopxu.thuysimedia.online/"><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>' })?.sha256).toBe(a!.sha256);
	});

	test("a different body, a body too small to tell kits apart, or no readable document has none in common", () => {
		const a = body("a.example.com", "1");
		expect(body("b.example.net", "1", { filler: "y".repeat(3_000) })?.sha256).not.toBe(a?.sha256);
		// A loader page that only fetches the real one (a blob smuggler, a redirect) is the same tiny body on unrelated kits.
		expect(body("c.example.org", "1", { filler: "", head: "x".repeat(5_000) })).toBeUndefined();
		expect(pageFingerprints(Buffer.from("not mhtml"), "https://a.example.com/")).toEqual({});
		expect(pageFingerprints(capture("a.example.com", "1"), "not a url")).toEqual({});
	});
});

describe("page structure fingerprint", () => {
	const brands = ["MPO1221", "DEWI11", "LIGA5000"];

	test("pages built from one template have one structure whatever their words, class names or <head>, but each its own body", () => {
		// Production: gambling SEO pages on hijacked domains, each naming another brand with generated text.
		const pages = brands.map((brand, index) => capture(`dua.site${index}.com`, String(index), {
			body: templatePage(8, (card) => `${brand} game ${card} ${"seru ".repeat(20 + index)}`),
			head: index === 1 ? '<link rel="canonical" href="https://www.site1.com/">' : "",
		}));
		const fingerprints = pages.map((mhtml, index) => pageFingerprints(mhtml, `https://dua.site${index}.com/894655`));
		expect(fingerprints[0]!.structure).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), size: expect.any(Number), tags: 8 + 8 * 8 });
		expect(new Set(fingerprints.map((fingerprint) => fingerprint.structure!.sha256)).size).toBe(1);
		expect(new Set(fingerprints.map((fingerprint) => fingerprint.body?.sha256)).size).toBe(3);
		// A USPS kit gives every element new random class names on each render: the same template.
		const randomized = structure("idcredian.com", { body: templatePage(8, () => "USPS", (card) => `k${card}x9${card} q${card * 7}z`) });
		expect(randomized?.sha256).toBe(fingerprints[0]!.structure!.sha256);
	});

	test("another template, a page with too few elements, or a provider's browser check has no structure in common", () => {
		const eight = structure("a.example.com", { body: templatePage(8, () => "a") });
		expect(structure("b.example.com", { body: templatePage(9, () => "a") })?.sha256).not.toBe(eight?.sha256);
		// A parking or error page has a handful of elements on unrelated sites.
		expect(structure("c.example.com", { body: templatePage(2, () => "a") })).toBeUndefined();
		// Cloudflare's "Just a moment..." check is Cloudflare's page in front of any site, not the site's.
		const check = (host: string) => pageFingerprints(capture(host, "1", {
			title: "Just a moment...",
			body: `<div class="main-wrapper"><h1>${host}</h1><h2 id="challenge-success-text">Verification successful</h2>${templatePage(8, () => "x")}${"y".repeat(3_000)}</div>`,
		}), `https://${host}/`);
		expect(check("www.drspigner.com")).toEqual({});
		expect(check("food.thefarmandmarket.com")).toEqual({});
	});
});
