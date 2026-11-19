import { describe, expect, test } from "bun:test";

import { pageDocumentFingerprint } from "./page_document";
import { kitCapture as capture } from "./test_mhtml";

describe("page document fingerprint", () => {
	test("one kit on many domains has one fingerprint, whatever the capture's part ids, encoding, or the deployment's <head>", () => {
		const a = pageDocumentFingerprint(capture("napxu.hoanganhmedia.sbs", "1111"), "https://napxu.hoanganhmedia.sbs/");
		expect(a?.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(a?.size).toBeGreaterThan(3_000);
		expect(pageDocumentFingerprint(capture("napxu.quanghung-media.site", "2222"), "https://napxu.quanghung-media.site/")?.sha256).toBe(a!.sha256);
		expect(pageDocumentFingerprint(capture("deposit-dawn-hood.trycloudflare.com", "3333", { base64: true }), "https://deposit-dawn-hood.trycloudflare.com/")?.sha256).toBe(a!.sha256);
		// One deployment of the kit adds a canonical link and analytics to its <head>: the same page.
		expect(pageDocumentFingerprint(capture("shopxu.thuysimedia.online", "4444", { head: '<link rel="canonical" href="https://shopxu.thuysimedia.online/"><script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>' }), "https://shopxu.thuysimedia.online/")?.sha256).toBe(a!.sha256);
	});

	test("a different body, a body too small to tell kits apart, or no readable document has none in common", () => {
		const a = pageDocumentFingerprint(capture("a.example.com", "1"), "https://a.example.com/");
		expect(pageDocumentFingerprint(capture("b.example.net", "1", { filler: "y".repeat(3_000) }), "https://b.example.net/")?.sha256).not.toBe(a?.sha256);
		// A loader page that only fetches the real one (a blob smuggler, a redirect) is the same tiny body on unrelated kits.
		expect(pageDocumentFingerprint(capture("c.example.org", "1", { filler: "", head: "x".repeat(5_000) }), "https://c.example.org/")).toBeUndefined();
		expect(pageDocumentFingerprint(Buffer.from("not mhtml"), "https://a.example.com/")).toBeUndefined();
		expect(pageDocumentFingerprint(capture("a.example.com", "1"), "not a url")).toBeUndefined();
	});
});
