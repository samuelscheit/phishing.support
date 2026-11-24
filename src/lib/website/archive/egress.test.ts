import { expect, test } from "bun:test";

import { archiveWebsite } from "./";
import { BrowserInfrastructureError, isBrowserInfrastructureFailure, WebsiteCaptureFailedError } from "./errors";
import { archiveBrowserFixture, fast, responseForNavigation } from "./test_fixture";

test("a navigation failure over the residential exit and Tor is retried from the server's direct exit", async () => {
	const url = "https://www8-receitafazendagerador.com/Aplicacao/Mei/pgmei.app";
	const fixture = archiveBrowserFixture({
		pageUrl: url,
		goto: async ({ egress }) => {
			if (egress !== "reporting") throw new Error(`net::ERR_TIMED_OUT at ${url}`);
			return responseForNavigation(url, 200, { contentType: "text/html" });
		},
	});

	const archive = await archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser });

	expect(fixture.leasedEgress).toEqual(["residential", "phishing", "reporting"]);
	expect(fixture.closeCount).toBe(3);
	expect(fixture.captureSnapshotCount).toBe(1);
	expect(archive.url).toBe(url);
	expect(archive.route).toBe("server IP");
});

test("a page the residential exit reaches is captured from it, and Tor and the server IP are never leased", async () => {
	const fixture = archiveBrowserFixture();

	const archive = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser: fixture.getBrowser });

	expect(fixture.leasedEgress).toEqual(["residential"]);
	expect(archive.egress).toBe("residential");
	expect(archive.cloaking).toBeUndefined();
});

test("an offline residential exit hands the capture to Tor", async () => {
	const fixture = archiveBrowserFixture();
	const getBrowser: typeof fixture.getBrowser = async (egress) => {
		if (egress === "residential") throw new Error("residential exit is offline");
		return fixture.getBrowser(egress);
	};

	const archive = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser });

	expect(archive.egress).toBe("phishing");
	expect(archive.route).toBe("Tor exit");
	expect(archive.cloaking).toBeUndefined();
});

test("website capture reports the navigation failure of every egress, including the residential exit, and closes each lease", async () => {
	const fixture = archiveBrowserFixture({
		goto: async () => { throw new Error("Navigation timeout of 30000 ms exceeded"); },
	});

	await expect(archiveWebsite(
		{ url: "https://example.test/" },
		{ ...fast, getBrowser: fixture.getBrowser },
	)).rejects.toThrow("Failed to load page: Navigation timeout of 30000 ms exceeded via residential exit; Navigation timeout of 30000 ms exceeded via Tor exit; Navigation timeout of 30000 ms exceeded via server IP");
	expect(fixture.leasedEgress).toEqual(["residential", "phishing", "reporting"]);
	expect(fixture.screenshotCount).toBe(0);
	expect(fixture.captureSnapshotCount).toBe(0);
	expect(fixture.closeCount).toBe(3);
});

test("a failure after the page loaded over Tor is not retried on another egress", async () => {
	const fixture = archiveBrowserFixture({ goto: async ({ egress, url }) => {
		if (egress === "residential") throw new Error(`net::ERR_CONNECTION_CLOSED at ${url}`);
		return responseForNavigation(url, 200, { contentType: "text/html" });
	} });
	const getBrowser: typeof fixture.getBrowser = async (egress) => {
		const browser = await fixture.getBrowser(egress);
		const context = browser.defaultBrowserContext();
		const newPage = context.newPage.bind(context);
		context.newPage = async () => Object.assign(await newPage(), { screenshot: async () => { throw new Error("Protocol error (Page.captureScreenshot)"); } });
		return Object.assign(browser, { defaultBrowserContext: () => context });
	};

	await expect(archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser })).rejects.toThrow("Protocol error (Page.captureScreenshot)");
	expect(fixture.leasedEgress).toEqual(["residential", "phishing"]);
	expect(fixture.closeCount).toBe(2);
});

test("any failure of the residential exit, even after the page loaded, falls through to Tor", async () => {
	const fixture = archiveBrowserFixture();
	const getBrowser: typeof fixture.getBrowser = async (egress) => {
		const browser = await fixture.getBrowser(egress);
		if (egress !== "residential") return browser;
		const context = browser.defaultBrowserContext();
		const newPage = context.newPage.bind(context);
		context.newPage = async () => Object.assign(await newPage(), { screenshot: async () => { throw new Error("Protocol error (Page.captureScreenshot)"); } });
		return Object.assign(browser, { defaultBrowserContext: () => context });
	};

	const archive = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser });

	expect(archive.egress).toBe("phishing");
	expect(fixture.leasedEgress).toEqual(["residential", "phishing"]);
	expect(fixture.closeCount).toBe(2);
});

test("browser-service failures are told apart from a site that cannot be reached", async () => {
	const unavailable = archiveBrowserFixture();
	const relayDown = async () => { throw Object.assign(new Event("error"), { message: "Unexpected server response: 503" }); };
	const relayError = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser: relayDown }).then(() => undefined, (error: unknown) => error);
	expect(relayError).toBeInstanceOf(BrowserInfrastructureError);
	expect((relayError as Error).message).toBe("Browser service unavailable: Unexpected server response: 503");
	expect(isBrowserInfrastructureFailure(relayError)).toBe(true);
	expect(unavailable.leasedEgress).toEqual([]);

	// A browser that closes during navigation is the service's fault, not the site's.
	const closed = archiveBrowserFixture({ goto: async () => { throw new Error("Protocol error (Page.navigate): Target closed"); } });
	const closedError = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser: closed.getBrowser }).then(() => undefined, (error: unknown) => error);
	expect(isBrowserInfrastructureFailure(closedError)).toBe(true);
	expect(closed.leasedEgress).toEqual(["residential", "phishing"]);
	// A frame the browser dropped under the capture (production case 383429267624562688's sampled visit).
	expect(isBrowserInfrastructureFailure(new Error("Attempted to use detached Frame 'F312968E370A7BA0C31894A079BFC237'."))).toBe(true);

	// A site that answers no route is final, even when a route's reason mentions a closed connection.
	const blocked = archiveBrowserFixture({ goto: async () => { throw new Error("net::ERR_CONNECTION_CLOSED at https://example.test/"); } });
	const blockedError = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser: blocked.getBrowser }).then(() => undefined, (error: unknown) => error);
	expect(blockedError).toBeInstanceOf(WebsiteCaptureFailedError);
	expect(isBrowserInfrastructureFailure(blockedError)).toBe(false);
	expect(blocked.leasedEgress).toEqual(["residential", "phishing", "reporting"]);
});

test("an HTTP error from the residential exit and Tor is retried from the server's direct exit", async () => {
	const url = "https://xfinityy111.weebly.com/";
	const fixture = archiveBrowserFixture({
		pageUrl: url,
		goto: async ({ egress }) => responseForNavigation(url, egress === "reporting" ? 200 : 403, { contentType: "text/html" }),
	});

	const archive = await archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser, errorDocumentSettleMs: 20 });

	expect(fixture.leasedEgress).toEqual(["residential", "phishing", "reporting"]);
	expect(fixture.closeCount).toBe(3);
	expect(fixture.captureSnapshotCount).toBe(1);
	expect(archive.url).toBe(url);
	expect(archive.navigationHops).toEqual([
		{ index: 0, url, hostname: "xfinityy111.weebly.com", status: 200, contentType: "text/html", contentCaptured: true },
	]);
});

test("a bot-check interstitial that reloads into the real page is captured with the real page's response", async () => {
	const url = "https://www8-receitafazendagerador.com/Aplicacao/Mei/pgmei.app";
	const realUrl = `${url}/`;
	const fixture = archiveBrowserFixture({
		pageUrl: url,
		goto: async ({ replaceDocument }) => {
			setTimeout(() => replaceDocument(responseForNavigation(realUrl, 200, {
				contentType: "text/html; charset=UTF-8",
				redirects: [{ url, status: 301, location: realUrl }],
			})), 30);
			return responseForNavigation(url, 403, { contentType: "text/html" });
		},
	});

	const archive = await archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser, errorDocumentSettleMs: 2_000 });

	expect(fixture.leasedEgress).toEqual(["residential"]);
	expect(fixture.captureSnapshotCount).toBe(1);
	expect(archive.url).toBe(realUrl);
	expect(archive.navigationHops).toEqual([
		{ index: 0, url, hostname: "www8-receitafazendagerador.com", status: 301, redirectTo: realUrl, contentType: "text/html", contentCaptured: false },
		{ index: 1, url: realUrl, hostname: "www8-receitafazendagerador.com", status: 200, contentType: "text/html; charset=UTF-8", contentCaptured: true },
	]);
});

test("an HTTP error on every egress fails with each route's status and page title", async () => {
	const url = "https://blocked.example/";
	const fixture = archiveBrowserFixture({
		pageUrl: url,
		goto: async ({ egress }) => responseForNavigation(url, egress === "residential" ? 403 : 503, { contentType: "text/html" }),
	});

	await expect(archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser, errorDocumentSettleMs: 20 })).rejects.toThrow(
		'Failed to load page: HTTP 403 ("Just a moment...") via residential exit; HTTP 503 ("Just a moment...") via Tor exit; HTTP 503 ("Just a moment...") via server IP',
	);
	expect(fixture.leasedEgress).toEqual(["residential", "phishing", "reporting"]);
	expect(fixture.captureSnapshotCount).toBe(0);
	expect(fixture.closeCount).toBe(3);
});
