import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type HTTPResponse, type Page, TimeoutError } from "rebrowser-puppeteer-core";
import type { FabricEgress } from "./browser/fabric";
import type { WebsiteNavigationHop } from "./website_types";

import { archiveWebsite, capturedDocumentContent, getMhtmlArchiveDate, getMhtmlArchiveLocation } from "./website_archive";

function mhtml(preamble: string, body = "content") {
	return Buffer.from(`${preamble}\r\n\r\n${body}`, "latin1");
}

describe("getMhtmlArchiveDate", () => {
	test("reads the top-level capture date", () => {
		const date = getMhtmlArchiveDate(
			mhtml(
				["From: <Saved by Blink>", "Snapshot-Content-Location: https://example.test/", "Date: Tue, 13 Jan 2026 14:50:56 +0100"].join(
					"\r\n",
				),
			),
		);

		expect(date?.toISOString()).toBe("2026-01-13T13:50:56.000Z");
	});

	test("folds continuation lines and ignores dates inside MIME parts", () => {
		const date = getMhtmlArchiveDate(
			mhtml(
				["From: <Saved by Blink>", "Date:", "\tTue, 13 Jan 2026 14:50:56 +0100"].join("\r\n"),
				"Date: Wed, 14 Jan 2026 14:50:56 +0100",
			),
		);

		expect(date?.toISOString()).toBe("2026-01-13T13:50:56.000Z");
	});

	test("accepts LF-only MHTML headers", () => {
		const date = getMhtmlArchiveDate(Buffer.from("Date: Tue, 13 Jan 2026 14:50:56 +0100\n\ncontent", "latin1"));

		expect(date?.toISOString()).toBe("2026-01-13T13:50:56.000Z");
	});

	test("returns undefined when the capture date is absent or invalid", () => {
		expect(getMhtmlArchiveDate(mhtml("From: <Saved by Blink>"))).toBeUndefined();
		expect(getMhtmlArchiveDate(mhtml("Date: not a date"))).toBeUndefined();
	});

	test("reads the top-level document URL, not a MIME part URL", () => {
		const snapshot = Buffer.from([
			"From: <Saved by Blink>",
			"Snapshot-Content-Location: https://final.example/landing",
			"",
			"Content-Location: https://embedded.example/",
		].join("\r\n"), "latin1");
		expect(getMhtmlArchiveLocation(snapshot)).toBe("https://final.example/landing");
		expect(getMhtmlArchiveLocation(mhtml("Snapshot-Content-Location: file:///etc/passwd"))).toBeUndefined();
	});
});

test("archiveWebsite parses a retained MHTML snapshot locally without opening a browser", async () => {
	const snapshot = Buffer.from([
		"From: <Saved by Blink>",
		"Content-Type: multipart/related; boundary=\"fabric-test\"",
		"",
		"--fabric-test",
		"Content-Type: text/html",
		"Content-Location: https://example.test/",
		"",
		"<html><head><title>Captured</title></head><body><p>Captured evidence</p><script>not-run()</script></body></html>",
		"--fabric-test--",
	].join("\r\n"), "utf8");

	const archive = await archiveWebsite({ url: "https://example.test/", mhtmlSnapshot: snapshot });
	expect(archive.html.toString()).toContain("Captured");
	expect(archive.text.toString()).toContain("Captured evidence");
	expect(archive.html.toString()).not.toContain("not-run");
	expect(archive.screenshotPng).toBeUndefined();
});

const mainFrame = {};
/** Live captures in tests wait only briefly for a page's own script navigation. */
const fast = { scriptNavigationSettleMs: 20 } as const;

function responseForNavigation(
	url: string,
	status: number,
	options: { location?: string; contentType?: string; redirects?: Array<{ url: string; status: number; location?: string }> } = {},
): HTTPResponse {
	const response = (hopUrl: string, hopStatus: number, headers: Record<string, string>, redirects: HTTPRequest[]): HTTPResponse => {
		let hopResponse: HTTPResponse;
		const request = {
			url: () => hopUrl,
			response: () => hopResponse,
			redirectChain: () => redirects,
			isNavigationRequest: () => true,
			resourceType: () => "document",
			frame: () => mainFrame,
		} as unknown as HTTPRequest;
		hopResponse = {
			ok: () => hopStatus >= 200 && hopStatus < 300,
			status: () => hopStatus,
			url: () => hopUrl,
			headers: () => headers,
			request: () => request,
		} as HTTPResponse;
		return hopResponse;
	};
	const redirects = options.redirects ?? [];
	const priorRequests: HTTPRequest[] = [];
	for (const redirect of redirects) {
		const redirectResponse = response(redirect.url, redirect.status, {
			...(redirect.location ? { location: redirect.location } : {}),
			"content-type": "text/html",
		}, priorRequests.slice());
		const redirectRequest = {
			url: () => redirect.url,
			response: () => redirectResponse,
			redirectChain: () => priorRequests.slice(),
		} as unknown as HTTPRequest;
		priorRequests.push(redirectRequest);
	}
	return response(url, status, {
		...(options.location ? { location: options.location } : {}),
		...(options.contentType ? { "content-type": options.contentType } : {}),
	}, priorRequests) as HTTPResponse;
}

type FixtureNavigation = {
	url: string;
	egress: FabricEgress;
	/** Deliver a later main-frame document response, as a self-replacing interstitial does. */
	replaceDocument: (response: HTTPResponse) => void;
	/** Deliver a subresource response (script, stylesheet, image) the page loaded. */
	loadResource: (response: HTTPResponse) => void;
};

/** A non-navigation subresource response with a body. */
function subresource(url: string, resourceType: string, body: string | Error, options: { status?: number; contentType?: string } = {}): HTTPResponse {
	const request = {
		url: () => url,
		isNavigationRequest: () => false,
		resourceType: () => resourceType,
		frame: () => mainFrame,
		redirectChain: () => [],
	} as unknown as HTTPRequest;
	return {
		ok: () => (options.status ?? 200) < 300,
		status: () => options.status ?? 200,
		url: () => url,
		headers: () => (options.contentType ? { "content-type": options.contentType } : {}),
		request: () => request,
		buffer: async () => {
			if (body instanceof Error) throw body;
			return Buffer.from(body);
		},
	} as unknown as HTTPResponse;
}

function archiveBrowserFixture(options: {
	goto?: (navigation: FixtureNavigation) => Promise<HTTPResponse | null>;
	/** How the page's network goes idle; may render the document's body meanwhile. */
	networkIdle?: (wait: { timeout?: number; render: (body: string) => void }) => Promise<void>;
	pageUrl?: string;
} = {}) {
	const eventNames: string[] = [];
	const navigationCalls: Array<{ url: string; egress: FabricEgress; waitUntil?: string; timeout?: number }> = [];
	const networkIdleWaits: Array<{ idleTime?: number; concurrency?: number; timeout?: number }> = [];
	const leasedEgress: FabricEgress[] = [];
	let interceptionEnabled = false;
	let screenshotCount = 0;
	let closeCount = 0;
	let captureSnapshotCount = 0;

	const getBrowser = async (egress: FabricEgress = "phishing") => {
		leasedEgress.push(egress);
		const responseListeners: Array<(response: HTTPResponse) => void> = [];
		let currentUrl = options.pageUrl ?? "https://example.test/";
		let body = "Captured page text";
		const context = {} as BrowserContext;
		const page = {
			browser: () => browser,
			browserContext: () => context,
			mainFrame: () => mainFrame,
			setViewport: async () => undefined,
			on: (event: string, listener: (response: HTTPResponse) => void) => {
				eventNames.push(event);
				if (event === "response") responseListeners.push(listener);
			},
			setRequestInterception: async (enabled: boolean) => { interceptionEnabled = enabled; },
			goto: async (url: string, navigation: { waitUntil?: string; timeout?: number }) => {
				navigationCalls.push({ url, egress, ...navigation });
				const deliver = (response: HTTPResponse) => {
					currentUrl = response.url();
					for (const listener of responseListeners) listener(response);
				};
				const loadResource = (response: HTTPResponse) => {
					for (const listener of responseListeners) listener(response);
				};
				const response = options.goto
					? await options.goto({ url, egress, replaceDocument: deliver, loadResource })
					: responseForNavigation(options.pageUrl ?? url, 200, { contentType: "text/html" });
				if (response) deliver(response);
				return response;
			},
			waitForNetworkIdle: async (wait: { idleTime?: number; concurrency?: number; timeout?: number }) => {
				networkIdleWaits.push(wait);
				await options.networkIdle?.({ timeout: wait.timeout, render: (html) => { body = html; } });
			},
			screenshot: async () => { screenshotCount++; return Buffer.from("png"); },
			target: () => ({
				createCDPSession: async () => ({
					send: async (method: string) => {
						if (method !== "Page.captureSnapshot") throw new Error(`Unexpected CDP command ${method}`);
						captureSnapshotCount++;
						return {
							data: [
								"From: <Saved by Blink>",
								`Snapshot-Content-Location: ${currentUrl}`,
								"Content-Type: multipart/related; boundary=\"archive-test\"",
								"",
								"--archive-test",
								"Content-Type: text/html",
								`Content-Location: ${currentUrl}`,
								"",
								`<html><head><title>Captured title</title></head><body>${body}</body></html>`,
								"--archive-test--",
							].join("\r\n"),
						};
					},
				}),
			}),
			evaluate: async (callback: () => unknown) => {
				if (callback.toString().includes("readyState")) return "interactive";
				throw new Error("Unexpected page evaluation");
			},
			title: async () => "Just a moment...",
			url: () => currentUrl,
		};
		const browser = {
			defaultBrowserContext: () => ({ ...context, newPage: async () => page }),
			close: async () => { closeCount++; },
		} as unknown as Browser;
		return browser;
	};

	return {
		getBrowser,
		eventNames,
		navigationCalls,
		networkIdleWaits,
		leasedEgress,
		get interceptionEnabled() { return interceptionEnabled; },
		get screenshotCount() { return screenshotCount; },
		get closeCount() { return closeCount; },
		get captureSnapshotCount() { return captureSnapshotCount; },
	};
}

test("a live capture records the hashes of the kit's own scripts and stylesheets as received", async () => {
	const url = "https://kit.example.com/signin";
	const script = "window.kit = " + "1;".repeat(600);
	const style = "body{" + "color:#123456;".repeat(100) + "}";
	const fixture = archiveBrowserFixture({
		goto: async ({ loadResource }) => {
			loadResource(subresource("https://kit.example.com/index.js?v=2", "script", script, { contentType: "application/javascript; charset=utf-8" }));
			loadResource(subresource("https://kit.example.com/res/style.css", "stylesheet", style, { contentType: "text/css" }));
			// The same script under a second URL is recorded once.
			loadResource(subresource("https://kit.example.com/index.js?v=3", "script", script, { contentType: "application/javascript" }));
			// Third-party files, images, failed responses and unreadable bodies are not kit evidence.
			loadResource(subresource("https://cdn.example.net/jquery.js", "script", "jquery", { contentType: "application/javascript" }));
			loadResource(subresource("https://kit.example.com/logo.png", "image", "png-bytes", { contentType: "image/png" }));
			loadResource(subresource("https://kit.example.com/missing.js", "script", "not found", { status: 404, contentType: "text/html" }));
			loadResource(subresource("https://kit.example.com/evicted.js", "script", new Error("No resource with given identifier found")));
			return responseForNavigation(url, 200, { contentType: "text/html" });
		},
	});
	const archive = await archiveWebsite({ url }, { getBrowser: fixture.getBrowser, ...fast });
	const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
	expect(archive.kitResources).toEqual([
		{ url: "https://kit.example.com/index.js?v=2", mimeType: "application/javascript", size: Buffer.byteLength(script), sha256: sha256(script) },
		{ url: "https://kit.example.com/res/style.css", mimeType: "text/css", size: Buffer.byteLength(style), sha256: sha256(style) },
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
	const archive = await archiveWebsite(
		{ url: requestedUrl },
		{ ...fast, getBrowser: fixture.getBrowser },
	);

	expect(fixture.navigationCalls).toEqual([{ url: requestedUrl, egress: "phishing", waitUntil: "domcontentloaded", timeout: 30_000 }]);
	expect(fixture.leasedEgress).toEqual(["phishing"]);
	expect(fixture.interceptionEnabled).toBe(false);
	expect(fixture.eventNames).not.toContain("request");
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

test("a navigation failure over Tor is retried from the server's direct exit", async () => {
	const url = "https://www8-receitafazendagerador.com/Aplicacao/Mei/pgmei.app";
	const fixture = archiveBrowserFixture({
		pageUrl: url,
		goto: async ({ egress }) => {
			if (egress === "phishing") throw new Error(`net::ERR_TIMED_OUT at ${url}`);
			return responseForNavigation(url, 200, { contentType: "text/html" });
		},
	});

	const archive = await archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser });

	expect(fixture.leasedEgress).toEqual(["phishing", "reporting"]);
	expect(fixture.closeCount).toBe(2);
	expect(fixture.captureSnapshotCount).toBe(1);
	expect(archive.url).toBe(url);
});

test("website capture reports the navigation failure of every egress, including the residential exit, and closes each lease", async () => {
	const fixture = archiveBrowserFixture({
		goto: async () => { throw new Error("Navigation timeout of 30000 ms exceeded"); },
	});

	await expect(archiveWebsite(
		{ url: "https://example.test/" },
		{ ...fast, getBrowser: fixture.getBrowser },
	)).rejects.toThrow("Failed to load page: Navigation timeout of 30000 ms exceeded via Tor exit; Navigation timeout of 30000 ms exceeded via server IP; Navigation timeout of 30000 ms exceeded via residential exit");
	expect(fixture.leasedEgress).toEqual(["phishing", "reporting", "residential"]);
	expect(fixture.screenshotCount).toBe(0);
	expect(fixture.captureSnapshotCount).toBe(0);
	expect(fixture.closeCount).toBe(3);
});

test("a failure after the page loaded is not retried on another egress", async () => {
	const fixture = archiveBrowserFixture();
	const getBrowser: typeof fixture.getBrowser = async (egress) => {
		const browser = await fixture.getBrowser(egress);
		const context = browser.defaultBrowserContext();
		const newPage = context.newPage.bind(context);
		context.newPage = async () => Object.assign(await newPage(), { screenshot: async () => { throw new Error("Protocol error (Page.captureScreenshot)"); } });
		return Object.assign(browser, { defaultBrowserContext: () => context });
	};

	await expect(archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser })).rejects.toThrow("Protocol error (Page.captureScreenshot)");
	expect(fixture.leasedEgress).toEqual(["phishing"]);
	expect(fixture.closeCount).toBe(1);
});

describe("rendering", () => {
	// A Flazio site builder page: the document is a shell, and the login form
	// arrives through XHR after DOMContentLoaded.
	const url = "https://microsoftoutlook.flazio.online/";
	const form = "<form><h1>Melden Sie sich bei Ihrem Microsoft-Konto an</h1><input type=\"email\" placeholder=\"E-Mail-Adresse\"><input type=\"password\" placeholder=\"Passwort\"></form>";

	test("waits for the page's own requests to finish so the capture holds the form they render", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			networkIdle: async ({ render }) => {
				await Bun.sleep(5);
				render(form);
			},
		});

		const archive = await archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser });

		expect(archive.text.toString()).toContain("Melden Sie sich bei Ihrem Microsoft-Konto an");
		expect(archive.text.toString()).toContain("E-Mail-Adresse");
		expect(archive.text.toString()).toContain("Passwort");
		expect(fixture.networkIdleWaits).toEqual([{ idleTime: 1_000, concurrency: 2, timeout: 10_000 }]);
	});

	test("a page that never goes quiet is captured as it stands once the bound passes", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			networkIdle: async ({ timeout, render }) => {
				render(form);
				await Bun.sleep(timeout ?? 0);
				throw new TimeoutError(`Timed out after waiting ${timeout}ms`);
			},
		});

		const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 20, getBrowser: fixture.getBrowser });

		expect(archive.text.toString()).toContain("E-Mail-Adresse");
		expect(fixture.networkIdleWaits).toEqual([{ idleTime: 20, concurrency: 2, timeout: 20 }]);
		expect(fixture.leasedEgress).toEqual(["phishing"]);
		expect(fixture.screenshotCount).toBe(1);
	});

	test("a browser failure while waiting is not mistaken for a slow page", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			networkIdle: async () => { throw new Error("Protocol error: Target closed"); },
		});

		await expect(archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser })).rejects.toThrow("Target closed");
		expect(fixture.leasedEgress).toEqual(["phishing"]);
		expect(fixture.screenshotCount).toBe(0);
		expect(fixture.closeCount).toBe(1);
	});

	test("waits on the document a cloaker's script navigated to, not on the interstitial", async () => {
		const interstitial = "https://interstitial.example/";
		const events: string[] = [];
		const fixture = archiveBrowserFixture({
			pageUrl: interstitial,
			goto: async ({ replaceDocument }) => {
				setTimeout(() => {
					events.push("script navigation");
					replaceDocument(responseForNavigation("https://interstitial.example/login", 200, { contentType: "text/html" }));
				}, 5);
				return responseForNavigation(interstitial, 200, { contentType: "text/html" });
			},
			networkIdle: async ({ render }) => {
				events.push("render");
				render(form);
			},
		});

		const archive = await archiveWebsite({ url: interstitial }, { scriptNavigationSettleMs: 1_100, getBrowser: fixture.getBrowser });

		expect(events).toEqual(["script navigation", "render"]);
		expect(archive.url).toBe("https://interstitial.example/login");
		expect(archive.text.toString()).toContain("E-Mail-Adresse");
	});
});

test("an HTTP error over Tor is retried from the server's direct exit", async () => {
	const url = "https://xfinityy111.weebly.com/";
	const fixture = archiveBrowserFixture({
		pageUrl: url,
		goto: async ({ egress }) => responseForNavigation(url, egress === "phishing" ? 403 : 200, { contentType: "text/html" }),
	});

	const archive = await archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser, errorDocumentSettleMs: 20 });

	expect(fixture.leasedEgress).toEqual(["phishing", "reporting"]);
	expect(fixture.closeCount).toBe(2);
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

	expect(fixture.leasedEgress).toEqual(["phishing"]);
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
		goto: async ({ egress }) => responseForNavigation(url, egress === "phishing" ? 403 : 503, { contentType: "text/html" }),
	});

	await expect(archiveWebsite({ url }, { ...fast, getBrowser: fixture.getBrowser, errorDocumentSettleMs: 20 })).rejects.toThrow(
		'Failed to load page: HTTP 403 ("Just a moment...") via Tor exit; HTTP 503 ("Just a moment...") via server IP; HTTP 503 ("Just a moment...") via residential exit',
	);
	expect(fixture.leasedEgress).toEqual(["phishing", "reporting", "residential"]);
	expect(fixture.captureSnapshotCount).toBe(0);
	expect(fixture.closeCount).toBe(3);
});


test("retrying retained MHTML preserves the submitted URL and exact captured-hop provenance", async () => {
	const requestedUrl = "https://share.google/ZAq2FghpGquJH6ShL";
	const finalUrl = "https://fuckyou.gay/";
	const navigationHops: WebsiteNavigationHop[] = [
		{ index: 0, url: requestedUrl, hostname: "share.google", status: 302, redirectTo: "https://www.google.com/", contentCaptured: false },
		{ index: 1, url: finalUrl, hostname: "fuckyou.gay", status: 200, contentCaptured: true },
	];
	const snapshot = Buffer.from([
		"From: <Saved by Blink>",
		`Content-Type: multipart/related; boundary="fabric-test"`,
		"",
		"--fabric-test",
		"Content-Type: text/html",
		"Content-Location: https://fuckyou.gay/",
		"",
		"<html><body>troll page</body></html>",
		"--fabric-test--",
	].join("\r\n"), "utf8");

	const archive = await archiveWebsite({ url: requestedUrl, archivedUrl: finalUrl, navigationHops, mhtmlSnapshot: snapshot });

	expect(archive.requestedUrl).toBe(requestedUrl);
	expect(archive.url).toBe(finalUrl);
	expect(archive.hostname).toBe("fuckyou.gay");
	expect(archive.navigationHops).toEqual(navigationHops);
	expect(archive.text.toString()).toContain("troll page");
});


test("legacy retained MHTML recovers its captured URL instead of assigning final content to the submitted shortener", async () => {
	const requestedUrl = "https://share.google/ZAq2FghpGquJH6ShL";
	const finalUrl = "https://fuckyou.gay/";
	const snapshot = Buffer.from([
		"From: <Saved by Blink>",
		`Snapshot-Content-Location: ${finalUrl}`,
		"Content-Type: multipart/related; boundary=\"fabric-test\"",
		"",
		"--fabric-test",
		"Content-Type: text/html",
		`Content-Location: ${finalUrl}`,
		"",
		"<html><body>troll page</body></html>",
		"--fabric-test--",
	].join("\r\n"), "utf8");

	const archive = await archiveWebsite({ url: requestedUrl, mhtmlSnapshot: snapshot, trustMhtmlDocumentLocation: true });

	expect(archive.requestedUrl).toBe(requestedUrl);
	expect(archive.url).toBe(finalUrl);
	expect(archive.hostname).toBe("fuckyou.gay");
	expect(archive.navigationHops).toEqual([
		{ index: 0, url: requestedUrl, hostname: "share.google", status: null, redirectTo: finalUrl, contentCaptured: false },
		{ index: 1, url: finalUrl, hostname: "fuckyou.gay", status: null, contentCaptured: true },
	]);
	expect(archive.text.toString()).toContain("troll page");
});


test("untrusted submitted MHTML cannot choose the URL associated with captured page evidence", async () => {
	const snapshot = Buffer.from([
		"From: <Saved by Blink>",
		"Snapshot-Content-Location: https://victim.example/login",
		"Content-Type: multipart/related; boundary=\"fabric-test\"",
		"",
		"--fabric-test",
		"Content-Type: text/html",
		"Content-Location: https://victim.example/login",
		"",
		"<html><body>untrusted uploaded snapshot</body></html>",
		"--fabric-test--",
	].join("\r\n"), "utf8");

	const archive = await archiveWebsite({ url: "https://submitter.example/", mhtmlSnapshot: snapshot });

	expect(archive.url).toBe("https://submitter.example/");
	expect(archive.navigationHops).toEqual([{
		index: 0,
		url: "https://submitter.example/",
		hostname: "submitter.example",
		status: null,
		contentCaptured: false,
	}]);
});

test("captured page text includes what visitors read from attributes, but never hidden or entered values", () => {
	const { html, text } = capturedDocumentContent(`<html><head><title>Microsoft</title><script>steal()</script></head><body>
<img src="logo.png" alt="Microsoft logo"><h1>Sign in</h1>
<input type="email" placeholder="Email, phone, or Skype"><input type="password" aria-label="Password">
<input type="hidden" name="token" value="session-secret"><input type="text" name="prefill" value="victim@example.test">
<input type="submit" value="Next"><div contenteditable aria-placeholder="Code"></div>
</body></html>`);

	for (const visible of ["Sign in", "Microsoft logo", "Email, phone, or Skype", "Password", "Next", "Code"]) {
		expect(text.split("\n")).toContain(visible);
	}
	expect(text).not.toContain("session-secret");
	expect(text).not.toContain("victim@example.test");
	expect(html).not.toContain("<script");
	expect(html).not.toContain("<img");
});

test("captured page text keeps attribute captions where a visitor reads them", () => {
	// A kit that labels its fields only with placeholders, quoted by the classifier across heading and fields.
	const { html, text } = capturedDocumentContent(`<html><body><form>
<p><img alt="Microsoft Logo"></p><h1>Iniciar sesión</h1><p>Verificación Microsoft</p>
<input type="email" placeholder="Correo electrónico, teléfono o Skype"><input type="text" placeholder="Contraseña de correo">
<a href="#">¿No puede acceder a su cuenta?</a><button aria-label="Siguiente">Siguiente</button>
</form></body></html>`);

	expect(text).toContain("Microsoft Logo\nIniciar sesión\nVerificación Microsoft\nCorreo electrónico, teléfono o Skype\nContraseña de correo\n¿No puede acceder a su cuenta?");
	// A caption equal to the element's own text is not repeated.
	expect(text.match(/Siguiente/g)).toHaveLength(1);
	expect(html).not.toContain("<img");
	expect(html.match(/Contraseña de correo/g)).toHaveLength(1);
});

test("captured page text leaves out filler a visitor cannot see, which kits use to drown out their form", () => {
	const filler = "Family photos stay in the local archive until the next backup.";
	const { html, text } = capturedDocumentContent(`<!DOCTYPE html><html><body>
<i style="font-size:0!important;opacity:0!important;position:absolute!important">${filler}</i>
<p style="color:transparent; font-size: 0px">${filler}</p><span hidden>${filler}</span><!-- ${filler} -->
<div style="display:none">${filler}</div><div style="visibility: hidden">${filler}</div>
<h1>Sign in with Apple Account</h1><input placeholder="Email or Phone Number">
<p style="opacity:0.5">Forgot password?</p><p style="font-size:0.9em">Keep me signed in</p>
</body></html>`);

	expect(text).toBe("Sign in with Apple Account\nEmail or Phone Number\nForgot password?\nKeep me signed in");
	expect(html).not.toContain(filler);
});

describe("cloaking", () => {
	const url = "https://lookup-lgr.to/en/verification";
	const decoyUrl = "https://www.wikipedia.org/";
	const kitUrl = "https://device.ledger-config.live/en";

	/** The submitted interstitial loads, then its script navigates to where its server sent this visitor. */
	function cloakerFixture(destination: (egress: FabricEgress) => string | undefined, options: { residentialOnline?: boolean } = {}) {
		return archiveBrowserFixture({
			pageUrl: url,
			goto: async ({ egress, replaceDocument }) => {
				if (egress === "residential" && options.residentialOnline === false) throw new Error("net::ERR_PROXY_CONNECTION_FAILED");
				const target = destination(egress);
				if (target) setTimeout(() => replaceDocument(responseForNavigation(target, 200, { contentType: "text/html; charset=utf-8" })), 5);
				return responseForNavigation(url, 200, { contentType: "text/html; charset=utf-8" });
			},
		});
	}
	const settle = { scriptNavigationSettleMs: 500 } as const;

	test("follows the interstitial's script navigation and records it as its own hop", async () => {
		const fixture = cloakerFixture(() => `${url}/done`);

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing"]);
		expect(archive.url).toBe(`${url}/done`);
		expect(archive.cloaking).toBeUndefined();
		expect(archive.navigationHops).toEqual([
			{ index: 0, url, hostname: "lookup-lgr.to", status: 200, redirectTo: `${url}/done`, contentType: "text/html; charset=utf-8", contentCaptured: false },
			{ index: 1, url: `${url}/done`, hostname: "lookup-lgr.to", status: 200, contentType: "text/html; charset=utf-8", contentCaptured: true },
		]);
	});

	test("a scripted jump to another site over Tor is repeated from the residential exit, which captures what a victim sees", async () => {
		const fixture = cloakerFixture((egress) => (egress === "residential" ? kitUrl : decoyUrl));

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		// The server IP is not tried: a cloaker answering Tor with a decoy is
		// already the signal, and the residential exit is the only route that helps.
		expect(fixture.leasedEgress).toEqual(["phishing", "residential"]);
		expect(fixture.closeCount).toBe(2);
		expect(archive.url).toBe(kitUrl);
		expect(archive.cloaking).toEqual({
			outcome: "detected",
			detail: `${url} sent the Tor exit to wikipedia.org but the residential exit to ledger-config.live`,
		});
		expect(archive.navigationHops.map(({ url: hopUrl, redirectTo, contentCaptured }) => ({ hopUrl, redirectTo, contentCaptured }))).toEqual([
			{ hopUrl: url, redirectTo: kitUrl, contentCaptured: false },
			{ hopUrl: kitUrl, redirectTo: undefined, contentCaptured: true },
		]);
	});

	test("the same scripted destination for every visitor is an ordinary redirect, not cloaking", async () => {
		const fixture = cloakerFixture(() => kitUrl);

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing", "residential"]);
		expect(archive.url).toBe(kitUrl);
		expect(archive.cloaking).toBeUndefined();
	});

	test("an offline residential exit leaves the decoy capture marked as unresolved cloaking", async () => {
		const fixture = cloakerFixture(() => decoyUrl, { residentialOnline: false });

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing", "residential"]);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking).toEqual({
			outcome: "unresolved",
			detail: `${url} sent the Tor exit to wikipedia.org by script; the residential exit capture failed: net::ERR_PROXY_CONNECTION_FAILED via residential exit`,
		});
	});

	test("a scripted destination that fails is unreachable, never a capture of Chromium's error page", async () => {
		// Production 2026-10-30: the residential exit followed the cloaker to the kit,
		// which redirected to a dead decoy host (HTTP 502). Chromium then showed
		// chrome-error://chromewebdata/, which was captured as if it were a site.
		const deadUrl = "http://ogenhoallin.com/";
		const fixture = archiveBrowserFixture({
			pageUrl: url,
			goto: async ({ egress, replaceDocument }) => {
				if (egress === "residential") {
					setTimeout(() => replaceDocument(Object.assign(
						responseForNavigation(deadUrl, 502, { contentType: "text/html", redirects: [{ url: "https://device.ledger-config.live/", status: 307, location: deadUrl }] }),
						{ url: () => deadUrl },
					)), 5);
					setTimeout(() => replaceDocument(responseForNavigation("chrome-error://chromewebdata/", 200, {})), 15);
				} else {
					setTimeout(() => replaceDocument(responseForNavigation(decoyUrl, 200, { contentType: "text/html" })), 5);
				}
				return responseForNavigation(url, 200, { contentType: "text/html; charset=utf-8" });
			},
		});

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing", "residential"]);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking).toEqual({
			outcome: "unresolved",
			detail: `${url} sent the Tor exit to wikipedia.org by script; the residential exit capture failed: the page sent the visitor to https://device.ledger-config.live/, which ended in HTTP 502 at ${deadUrl} via residential exit`,
		});
	});

	test("a site unreachable over Tor and the server IP is tried once more from the residential exit", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: kitUrl,
			goto: async ({ egress }) => {
				if (egress !== "residential") throw new Error(`net::ERR_CONNECTION_RESET at ${kitUrl}`);
				return responseForNavigation(kitUrl, 200, { contentType: "text/html" });
			},
		});

		const archive = await archiveWebsite({ url: kitUrl }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing", "reporting", "residential"]);
		expect(archive.url).toBe(kitUrl);
		expect(archive.cloaking).toBeUndefined();
	});

	test("an HTTP redirect to another site is the host's declared destination and never triggers the residential exit", async () => {
		const fixture = archiveBrowserFixture({
			pageUrl: kitUrl,
			goto: async () => responseForNavigation(kitUrl, 200, { contentType: "text/html", redirects: [{ url, status: 302, location: kitUrl }] }),
		});

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing"]);
		expect(archive.cloaking).toBeUndefined();
	});
});

const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const chromiumAvailable = await Bun.file(chromiumExecutable).exists();

describe.skipIf(!chromiumAvailable)("verification gates, in a real browser", () => {
	const filler = "Family photos stay in the local archive until the next backup.";
	const hiddenFiller = `<i style="font-size:0!important;opacity:0!important;position:absolute!important">${filler}</i>`.repeat(40);
	const appleForm = `<h1>Sign in with Apple Account</h1><input id="email" placeholder="Email or Phone Number"><input id="password" type="password" placeholder="Password"><button type="submit">Sign In</button>`;

	/** Serves one kit page; `/verify` answers after a silent proof of work, like the workers.dev kit. */
	function serveKit(page: string, hits: string[]) {
		return Bun.serve({
			port: 0,
			fetch: async (request) => {
				const { pathname } = new URL(request.url);
				hits.push(pathname);
				if (pathname === "/verify") return Response.json({ ok: true });
				if (pathname === "/login-form") return new Response(appleForm, { headers: { "content-type": "text/html" } });
				return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
			},
		});
	}

	const launch = async () => puppeteer.launch({ executablePath: chromiumExecutable, headless: true, args: ["--no-first-run"] });

	test("clicks the kit's own 'I'm not a robot' control and captures the sign-in page it reveals", async () => {
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><head><title>\u200b</title></head><body>${hiddenFiller}
<main><section id="gate"><h1>Security Check</h1>
<div role="button" tabindex="0" id="box" aria-label="I'm not a robot"><span class="check"></span><span>I'm not a robot</span><div>reCAPTCHA</div><div>Privacy - Terms</div></div>
</section><div id="content"></div></main>
<footer>Copyright © 2024 Apple Inc. All rights reserved.</footer>
<script>
document.getElementById("box").addEventListener("click", async () => {
	// A silent proof of work before the kit talks to its backend again.
	const until = Date.now() + 1500; while (Date.now() < until) await new Promise((r) => setTimeout(r, 50));
	await fetch("/verify", { method: "POST" });
	const html = await (await fetch("/login-form")).text();
	document.getElementById("gate").remove();
	document.getElementById("content").innerHTML = html;
});
</script></body></html>`, hits);
		try {
			const url = `http://127.0.0.1:${server.port}/c2222120`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 5_000, getBrowser: launch });

			expect(archive.verificationGate).toEqual({ label: "I'm not a robot" });
			const text = archive.text.toString();
			expect(text).toContain("Sign in with Apple Account");
			expect(text).toContain("Email or Phone Number");
			expect(text).not.toContain("Security Check");
			expect(text).not.toContain(filler);
			expect(hits).toEqual(["/c2222120", "/verify", "/login-form"]);
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("captures a kit that swaps its real page in from a blob: URL as the page it loaded", async () => {
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body><div class="spinner"></div><script>
setTimeout(async () => {
	const html = "<!DOCTYPE html><html><body>${appleForm.replaceAll('"', '\\"')}</body></html>";
	location.replace(URL.createObjectURL(new Blob([html], { type: "text/html" })));
}, 50);
</script></body></html>`, hits);
		try {
			const url = `http://127.0.0.1:${server.port}/c2222120`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 2_000, getBrowser: launch });

			expect(archive.url).toBe(url);
			expect(archive.navigationHops).toEqual([expect.objectContaining({ url, status: 200, contentCaptured: true })]);
			expect(archive.text.toString()).toContain("Sign in with Apple Account");
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("captures a kit that swaps in its blob: page before the page finishes loading as the page it loaded", async () => {
		const hits: string[] = [];
		// secure.nicholasmeeker.com replaced itself synchronously, so the browser's
		// own navigation result was the blob: document rather than the site.
		const server = serveKit(`<!DOCTYPE html><html><head><script>
location.replace(URL.createObjectURL(new Blob(["<!DOCTYPE html><html><body>${appleForm.replaceAll('"', '\\"')}</body></html>"], { type: "text/html" })));
</script></head><body></body></html>`, hits);
		try {
			const url = `http://127.0.0.1:${server.port}/c2222120`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 2_000, getBrowser: launch });

			expect(archive.url).toBe(url);
			expect(archive.hostname).toBe("127.0.0.1");
			expect(archive.navigationHops).toEqual([expect.objectContaining({ url, hostname: "127.0.0.1", status: 200, contentCaptured: true })]);
			expect(archive.text.toString()).toContain("Sign in with Apple Account");
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("never clicks anything on a page that already shows data-entry fields, even next to a robot checkbox", async () => {
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body>${appleForm}
<label><input type="checkbox" id="robot" onclick="fetch('/verify', { method: 'POST' })"> I'm not a robot</label></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/login` }, { ...fast, renderSettleMs: 1_000, getBrowser: launch });

			expect(archive.verificationGate).toBeUndefined();
			expect(archive.text.toString()).toContain("Sign in with Apple Account");
			expect(hits).toEqual(["/login"]);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("leaves a page alone when more than one control could be the gate", async () => {
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body><h1>Choose</h1>
<button onclick="fetch('/verify', { method: 'POST' })">I'm not a robot</button>
<button onclick="fetch('/verify', { method: 'POST' })">Verify you are human</button></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/two` }, { ...fast, renderSettleMs: 1_000, getBrowser: launch });

			expect(archive.verificationGate).toBeUndefined();
			expect(hits).toEqual(["/two"]);
		} finally {
			server.stop(true);
		}
	}, 60_000);
});
