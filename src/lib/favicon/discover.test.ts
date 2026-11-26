import { describe, expect, test } from "bun:test";

import { decodeDataUrl, iconCandidates } from "./discover";

const urls = (html: string, page = "https://www.example.com/en/home") => iconCandidates(html, page).map(({ url }) => url);

describe("iconCandidates", () => {
	test("resolves relative, root-relative and protocol-relative hrefs against the page, and always ends with /favicon.ico", () => {
		expect(urls(`
			<link rel="icon" href="img/a.png">
			<link rel="icon" href="/b.png">
			<link rel="icon" href="//cdn.example.net/c.png">
		`)).toEqual([
			"https://www.example.com/en/img/a.png",
			"https://www.example.com/b.png",
			"https://cdn.example.net/c.png",
			"https://www.example.com/favicon.ico",
		]);
	});

	test("prefers a declared square raster nearest 64 px, then touch icons, vectors, undeclared rasters, small rasters, /favicon.ico, and a mask last", () => {
		expect(urls(`
			<link rel="mask-icon" href="/mask.svg" color="#000">
			<link rel="shortcut icon" href="/favicon-16.png" sizes="16x16">
			<link rel="icon" href="/plain.png">
			<link rel="icon" type="image/svg+xml" href="/vector.svg">
			<link rel="apple-touch-icon" href="/touch.png">
			<link rel="icon" href="/favicon-192.png" sizes="192x192">
			<link rel="icon" href="/favicon-32.png" sizes="32x32">
			<link rel="icon" href="/favicon-64.png" sizes="64x64">
		`, "https://example.com/")).toEqual([
			"https://example.com/favicon-64.png",
			"https://example.com/favicon-32.png",
			"https://example.com/favicon-192.png",
			"https://example.com/touch.png",
			"https://example.com/vector.svg",
			"https://example.com/plain.png",
			"https://example.com/favicon-16.png",
			"https://example.com/favicon.ico",
			"https://example.com/mask.svg",
		]);
	});

	test("one link with several sizes counts by its best fitting size; a non-square size counts for nothing", () => {
		const candidates = iconCandidates(`
			<link rel="icon" href="/wide.png" sizes="64x32">
			<link rel="icon" href="/multi.ico" sizes="16x16 48x48 256x256">
		`, "https://example.com/");
		expect(candidates.map(({ url, sizes }) => [url, sizes])).toEqual([
			["https://example.com/multi.ico", [16, 48, 256]],
			["https://example.com/wide.png", []],
			["https://example.com/favicon.ico", []],
		]);
	});

	test("resolves against <base href>, itself relative to the page, but /favicon.ico against the page's own origin", () => {
		expect(urls(`<base href="/static/v2/"><link rel="icon" href="icon.png">`, "https://example.com/a/b")).toEqual([
			"https://example.com/static/v2/icon.png",
			"https://example.com/favicon.ico",
		]);
		expect(urls(`<base href="https://cdn.example.net/assets/"><link rel="icon" href="icon.png">`, "https://example.com/")).toEqual([
			"https://cdn.example.net/assets/icon.png",
			"https://example.com/favicon.ico",
		]);
	});

	test("keeps data: icons (they need no request), drops hrefs no image loads from, and lists a URL once", () => {
		expect(urls(`
			<link rel="icon" href="data:image/png;base64,iVBORw0KGgo=" sizes="32x32">
			<link rel="icon" href="javascript:alert(1)">
			<link rel="icon" href="ftp://example.com/x.ico">
			<link rel="icon" href="   ">
			<link rel="icon" href="/favicon.ico">
			<link rel="apple-touch-icon-precomposed" href="/favicon.ico">
		`, "https://example.com/")).toEqual(["data:image/png;base64,iVBORw0KGgo=", "https://example.com/favicon.ico"]);
	});

	test("reads rel and attribute names in any case, entities in hrefs, and ignores links that are not icons", () => {
		expect(urls(`
			<LINK REL="Shortcut Icon" HREF="/a.png?x=1&amp;y=2">
			<link rel="stylesheet" href="/site.css">
			<link rel="preload" href="/icon-font.woff2">
			<link rel="iconic" href="/not-an-icon.png">
		`, "https://example.com/")).toEqual(["https://example.com/a.png?x=1&y=2", "https://example.com/favicon.ico"]);
	});

	test("a page with no head, or no HTML at all, still has /favicon.ico", () => {
		expect(urls("", "https://example.com/somewhere")).toEqual(["https://example.com/favicon.ico"]);
		expect(urls("{\"not\":\"html\"}", "https://example.com/")).toEqual(["https://example.com/favicon.ico"]);
	});
});

describe("decodeDataUrl", () => {
	test("decodes base64 and percent-encoded bodies with their declared type", () => {
		expect(decodeDataUrl("data:image/png;base64,iVBORw0KGgo=")).toEqual({ type: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
		expect(decodeDataUrl("data:image/svg+xml,%3Csvg%20xmlns%3D%22x%22%2F%3E")).toEqual({ type: "image/svg+xml", bytes: Buffer.from("<svg xmlns=\"x\"/>") });
		expect(decodeDataUrl("data:,hello")).toEqual({ type: "text/plain", bytes: Buffer.from("hello") });
	});

	test("refuses what is no data: URL or does not decode", () => {
		expect(decodeDataUrl("data:image/png;base64")).toBeUndefined();
		expect(decodeDataUrl("data:image/svg+xml,%E0%A4%A")).toBeUndefined();
	});
});
