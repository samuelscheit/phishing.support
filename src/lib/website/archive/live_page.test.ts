import { expect, test } from "bun:test";

import { sha256Hex } from "../../util/hash";
import { archiveBrowserFixture, BLANK_PNG, fast, PAINTED_PNG, responseForNavigation, subresource, firstPage } from "./test_fixture";

test("a live capture records the hashes of every host's scripts and stylesheets as received", async () => {
	const url = "https://kit.example.com/signin";
	const script = "window.kit = " + "1;".repeat(600);
	const style = "body{" + "color:#123456;".repeat(100) + "}";
	const fixture = archiveBrowserFixture({
		goto: async ({ loadResource }) => {
			loadResource(subresource("https://kit.example.com/index.js?v=2", "script", script, { contentType: "application/javascript; charset=utf-8" }));
			loadResource(subresource("https://kit.example.com/res/style.css", "stylesheet", style, { contentType: "text/css" }));
			// The same script under a second URL is recorded once.
			loadResource(subresource("https://kit.example.com/index.js?v=3", "script", script, { contentType: "application/javascript" }));
			// A loader kit's code on its backend host is kept like the page's own.
			loadResource(subresource("https://backend.example.net/gmail/js/start.js", "script", "start", { contentType: "application/javascript" }));
			// Images, failed responses and unreadable bodies are not kit evidence.
			loadResource(subresource("https://kit.example.com/logo.png", "image", "png-bytes", { contentType: "image/png" }));
			loadResource(subresource("https://kit.example.com/missing.js", "script", "not found", { status: 404, contentType: "text/html" }));
			loadResource(subresource("https://kit.example.com/evicted.js", "script", new Error("No resource with given identifier found")));
			return responseForNavigation(url, 200, { contentType: "text/html" });
		},
	});
	const archive = await firstPage({ url }, { getBrowser: fixture.getBrowser, ...fast });
	expect(archive.kitResources).toEqual([
		{ url: "https://kit.example.com/index.js?v=2", mimeType: "application/javascript", size: Buffer.byteLength(script), sha256: sha256Hex(script) },
		{ url: "https://kit.example.com/res/style.css", mimeType: "text/css", size: Buffer.byteLength(style), sha256: sha256Hex(style) },
		{ url: "https://backend.example.net/gmail/js/start.js", mimeType: "application/javascript", size: 5, sha256: sha256Hex("start") },
	]);
});

test("website capture records every redirect response separately from the final page evidence", async () => {
	const requestedUrl = "https://share.google/ZAq2FghpGquJH6ShL";
	const googleUrl = "https://www.google.com/share.google?q=ZAq2FghpGquJH6ShL";
	const workerUrl = "https://dark-haze-3505.silo1.workers.dev/";
	const destinationUrl = "https://fuckyou.gay/";
	const fixture = archiveBrowserFixture({
		pageUrl: destinationUrl,
		goto: async () => responseForNavigation(destinationUrl, 200, {
			contentType: "text/html; charset=UTF-8",
			redirects: [
				{ url: requestedUrl, status: 302, location: googleUrl },
				{ url: googleUrl, status: 301, location: workerUrl },
				{ url: workerUrl, status: 302, location: destinationUrl },
			],
		}),
	});
	const archive = await firstPage(
		{ url: requestedUrl },
		{ ...fast, getBrowser: fixture.getBrowser },
	);

	expect(fixture.navigationCalls).toEqual([{ url: requestedUrl, egress: "residential", waitUntil: "domcontentloaded", timeout: 30_000 }]);
	expect(fixture.leasedEgress).toEqual(["residential"]);
	// Requests are only observed (a hidden frame's uploads), never intercepted.
	expect(fixture.interceptionEnabled).toBe(false);
	expect(archive.requestedUrl).toBe(requestedUrl);
	expect(archive.url).toBe(destinationUrl);
	expect(archive.hostname).toBe("fuckyou.gay");
	expect(archive.navigationHops).toEqual([
		{ index: 0, url: requestedUrl, hostname: "share.google", status: 302, redirectTo: googleUrl, contentType: "text/html", contentCaptured: false },
		{ index: 1, url: googleUrl, hostname: "www.google.com", status: 301, redirectTo: workerUrl, contentType: "text/html", contentCaptured: false },
		{ index: 2, url: workerUrl, hostname: "dark-haze-3505.silo1.workers.dev", status: 302, redirectTo: destinationUrl, contentType: "text/html", contentCaptured: false },
		{ index: 3, url: destinationUrl, hostname: "fuckyou.gay", status: 200, contentType: "text/html; charset=UTF-8", contentCaptured: true },
	]);
	expect(fixture.captureSnapshotCount).toBe(1);
	expect(fixture.screenshotCount).toBe(1);
	expect(fixture.closeCount).toBe(1);
	expect(archive.text.toString()).toContain("Captured page text");
});

test("a blank screenshot of a page that shows text is taken again once the page has painted", async () => {
	const fixture = archiveBrowserFixture({ screenshots: [BLANK_PNG, BLANK_PNG, PAINTED_PNG] });

	const archive = await firstPage({ url: "https://example.test/" }, { ...fast, getBrowser: fixture.getBrowser });

	expect(fixture.screenshotCount).toBe(3);
	expect(archive.screenshotPng?.equals(PAINTED_PNG)).toBeTrue();
	expect(archive.route).toBe("residential exit");
});

test("a page that cannot be pictured is captured without a screenshot, not failed as a browser outage", async () => {
	// Production case 380167497774534682: a redirect script whose target answered 204 left a
	// document whose screenshots Chromium refused ("0 width") or never answered.
	const refused = archiveBrowserFixture({ screenshots: [new Error("Protocol error (Page.captureScreenshot): Cannot take screenshot with 0 width.")] });
	const refusedArchive = await firstPage({ url: "https://example.test/" }, { ...fast, getBrowser: refused.getBrowser });
	expect(refusedArchive.screenshotPng).toBeUndefined();
	expect(refusedArchive.mhtml.toString()).toContain("Captured page text");

	const hung = archiveBrowserFixture({ screenshots: ["hang"] });
	const started = Date.now();
	const hungArchive = await firstPage({ url: "https://example.test/" }, { ...fast, screenshotTimeoutMs: 50, getBrowser: hung.getBrowser });
	expect(hungArchive.screenshotPng).toBeUndefined();
	expect(hungArchive.text.toString()).toContain("Captured page text");
	expect(Date.now() - started).toBeLessThan(5_000);

	// A page too tall for one picture (a tarpit streaming visible filler) is pictured as far as the visitor sees it.
	const tall = archiveBrowserFixture({ screenshots: [new Error("Protocol error (Page.captureScreenshot): Page is too large."), PAINTED_PNG] });
	const tallArchive = await firstPage({ url: "https://example.test/" }, { ...fast, getBrowser: tall.getBrowser });
	expect(tallArchive.screenshotPng?.equals(PAINTED_PNG)).toBeTrue();
	expect(tall.screenshotFullPage).toEqual([true, false]);
	// The viewport refused too is a browser failure like any other.
	const tallBroken = archiveBrowserFixture({ screenshots: [new Error("Page is too large."), new Error("Page is too large.")] });
	await expect(firstPage({ url: "https://example.test/" }, { ...fast, getBrowser: tallBroken.getBrowser })).rejects.toThrow("Page is too large");

	// Any other screenshot failure is still the browser's, and fails the capture.
	const closed = archiveBrowserFixture({ screenshots: [new Error("Protocol error (Page.captureScreenshot): Target closed")] });
	await expect(firstPage({ url: "https://example.test/" }, { ...fast, getBrowser: closed.getBrowser })).rejects.toThrow("Target closed");
});

test("a page that stays blank is captured blank after a bounded number of attempts", async () => {
	const fixture = archiveBrowserFixture({ screenshots: [BLANK_PNG] });

	const archive = await firstPage({ url: "https://example.test/" }, { ...fast, getBrowser: fixture.getBrowser });

	expect(fixture.screenshotCount).toBe(4);
	expect(archive.screenshotPng?.equals(BLANK_PNG)).toBeTrue();
});
